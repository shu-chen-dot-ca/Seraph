"""This computer's use, for the Resource page: CPU, memory, GPUs, disk, network, battery and fans.

One thread reads it about once a second from Linux's own files (/proc and /sys), for as long as the backend
runs, so nothing has to be installed and nothing needs root. The last 60 readings (samples) are kept for the
charts, only in memory, like the VMs' usage (sandbox/vms.py). What each VM uses is in the VMs' own records.

The NVIDIA GPU is the exception. Asking it for its numbers (nvidia-smi) wakes it from sleep and keeps it awake,
which drains a laptop's battery. So it is only asked while a browser shows a Resource page (watchers: the live
feed in backend/app.py counts them), and never while it sleeps. A GPU's state says whether there are numbers:
"on" (there are), "asleep", "not_watched", "in_vm" (given to a VM, so this computer can't read it), "no_driver",
"unknown" (a kind of GPU this file can't read) or "error".
The built-in AMD graphics (amdgpu) are read from /sys at any time: that wakes nothing.

ResourceUsage.version goes up on every reading, so the live feed sends the "resource" topic once a second:

    {"cpu": {"name", "threads", "percent", "per_thread", "mhz", "temp_c"},
     "memory": {"total_gb", "used_gb", "swap_total_gb", "swap_used_gb"},
     "gpus": [{"address", "vendor", "name", "state", "percent", "memory_used_gb", "memory_total_gb",
               "shared_used_gb", "shared_total_gb", "temp_c", "power_w", "mhz"}],
     "disk": {"total_gb", "used_gb", "read_rate", "write_rate", "temp_c"},
     "network": {"interface", "down_rate", "up_rate"},
     "battery": None or {"percent", "status", "power_w", "plugged_in"},
     "fans": [rpm, ...],
     "samples": [{"cpu_percent", "memory_used_gb", "gpu_percent" (one per GPU), "disk_read_rate",
                  "disk_write_rate", "net_down_rate", "net_up_rate"}]}

Rates are bytes a second. A number is None when this computer doesn't have it, or before the second reading
(a rate needs two). "shared" is the system memory a built-in GPU borrows.
"""

import os
import shlex
import subprocess
import threading
import time
from pathlib import Path

SAMPLES_KEPT = 60
GB = 1024**3
VENDORS = {"0x10de": "nvidia", "0x1002": "amd", "0x8086": "intel"}
VENDOR_NAMES = {"nvidia": "NVIDIA", "amd": "AMD", "intel": "Intel"}


class ResourceUsage:
    def __init__(self):
        self.version = 0
        # How many browsers show a Resource page right now. Only the live feed changes it (backend/app.py).
        self.watchers = 0
        self.usage = None
        self.samples = []
        # The counters at the last reading, for the percentages and rates.
        self.last = None

        self.cpu_name = ""
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                self.cpu_name = line.split(":", 1)[1].strip()
                break

        # The sensors, found once: CPU temperature, the disks' temperatures and the fans.
        self.cpu_temp = None
        self.disk_temps = []
        self.fans = []
        for hwmon in sorted(Path("/sys/class/hwmon").iterdir()):
            if not (hwmon / "name").exists():
                continue
            name = (hwmon / "name").read_text().strip()
            if name in ["k10temp", "coretemp", "zenpower"] and (hwmon / "temp1_input").exists():
                self.cpu_temp = hwmon / "temp1_input"
            if name == "nvme" and (hwmon / "temp1_input").exists():
                self.disk_temps.append(hwmon / "temp1_input")
            self.fans += sorted(hwmon.glob("fan*_input"))

        # The graphics cards, found once: PCI address, vendor and a name a person knows.
        self.gpus = []
        for device in sorted(Path("/sys/bus/pci/devices").iterdir()):
            if not (device / "class").read_text().startswith("0x03"):
                continue
            vendor = VENDORS.get((device / "vendor").read_text().strip(), "other")
            name = device.name
            try:
                fields = shlex.split(subprocess.run(["lspci", "-mm", "-s", device.name], capture_output=True, text=True, timeout=5).stdout)
                name = fields[3]
                # "GA106 [GeForce RTX 3060]": the part in brackets is the one on the box.
                if "[" in name:
                    name = name.split("[", 1)[1].rstrip("]")
                name = f"{VENDOR_NAMES.get(vendor, '')} {name}".strip()
            except Exception:
                pass
            # Built-in AMD graphics are named in the CPU's name: "AMD Ryzen 7 5700U w/ Radeon Graphics".
            if vendor == "amd" and " w/ " in self.cpu_name:
                name = "AMD " + self.cpu_name.split(" w/ ", 1)[1]
            self.gpus.append({"device": device, "vendor": vendor, "name": name})

        threading.Thread(target=self.watch, daemon=True).start()

    def watch(self) -> None:
        """Read everything about once a second, for as long as the backend runs."""
        while True:
            try:
                usage = self.read()
                sample = {
                    "cpu_percent": usage["cpu"]["percent"],
                    "memory_used_gb": usage["memory"]["used_gb"],
                    "gpu_percent": [gpu["percent"] for gpu in usage["gpus"]],
                    "disk_read_rate": usage["disk"]["read_rate"],
                    "disk_write_rate": usage["disk"]["write_rate"],
                    "net_down_rate": usage["network"]["down_rate"],
                    "net_up_rate": usage["network"]["up_rate"],
                }
                # New objects each time, so the live feed never sends one half changed.
                self.samples = self.samples[-(SAMPLES_KEPT - 1):] + [sample]
                self.usage = usage
                self.version += 1
            except Exception:
                pass  # A file that went away for a moment; try again next round.
            time.sleep(1)

    def summary(self) -> dict | None:
        if self.usage is None:
            return None
        return {**self.usage, "samples": self.samples}

    def read(self) -> dict:
        now = time.monotonic()
        last = self.last

        # CPU: the busy and total time of all threads ("cpu") and each one ("cpu0", ...), since boot.
        times = {}
        for line in Path("/proc/stat").read_text().splitlines():
            if not line.startswith("cpu"):
                continue
            fields = line.split()
            numbers = [int(number) for number in fields[1:9]]
            idle = numbers[3] + numbers[4]
            times[fields[0]] = (sum(numbers) - idle, sum(numbers))
        threads = [name for name in times if name != "cpu"]
        cpu_percent = None
        per_thread = [None] * len(threads)
        if last is not None:
            busy = times["cpu"][0] - last["cpu"]["cpu"][0]
            total = times["cpu"][1] - last["cpu"]["cpu"][1]
            if total > 0:
                cpu_percent = busy / total * 100
            for index, name in enumerate(threads):
                busy = times[name][0] - last["cpu"].get(name, times[name])[0]
                total = times[name][1] - last["cpu"].get(name, times[name])[1]
                if total > 0:
                    per_thread[index] = busy / total * 100
        speeds = []
        for path in Path("/sys/devices/system/cpu").glob("cpu[0-9]*/cpufreq/scaling_cur_freq"):
            speeds.append(int(path.read_text()) / 1000)
        cpu = {
            "name": self.cpu_name,
            "threads": len(threads),
            "percent": cpu_percent,
            "per_thread": per_thread,
            "mhz": sum(speeds) / len(speeds) if speeds else None,
            "temp_c": int(self.cpu_temp.read_text()) / 1000 if self.cpu_temp is not None else None,
        }

        # Memory, in kB in /proc/meminfo. Used is what programs hold: all of it but what is free or only cache.
        meminfo = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            fields = line.split()
            meminfo[fields[0].rstrip(":")] = int(fields[1]) * 1024
        memory = {
            "total_gb": meminfo["MemTotal"] / GB,
            "used_gb": (meminfo["MemTotal"] - meminfo["MemAvailable"]) / GB,
            "swap_total_gb": meminfo["SwapTotal"] / GB,
            "swap_used_gb": (meminfo["SwapTotal"] - meminfo["SwapFree"]) / GB,
        }

        gpus = []
        for found in self.gpus:
            gpus.append(self.read_gpu(found))

        # Disk: the space on / (the main disk), and what the real disks read and write.
        # /proc/diskstats counts 512-byte sectors; only disks with a device are real (not dm-0, loop or zram).
        space = os.statvfs("/")
        disk_read = 0
        disk_write = 0
        for line in Path("/proc/diskstats").read_text().splitlines():
            fields = line.split()
            if Path(f"/sys/block/{fields[2]}/device").exists():
                disk_read += int(fields[5]) * 512
                disk_write += int(fields[9]) * 512
        disk_temps = [int(path.read_text()) / 1000 for path in self.disk_temps]
        disk = {
            "total_gb": space.f_blocks * space.f_frsize / GB,
            "used_gb": (space.f_blocks - space.f_bfree) * space.f_frsize / GB,
            "read_rate": None,
            "write_rate": None,
            "temp_c": max(disk_temps) if disk_temps else None,
        }

        # Network: the connection to the internet, the one the default route goes out of (Wi-Fi or a cable).
        interface = None
        for line in Path("/proc/net/route").read_text().splitlines()[1:]:
            fields = line.split()
            if fields[1] == "00000000":
                interface = fields[0]
                break
        net_down = None
        net_up = None
        if interface is not None:
            net_down = int(Path(f"/sys/class/net/{interface}/statistics/rx_bytes").read_text())
            net_up = int(Path(f"/sys/class/net/{interface}/statistics/tx_bytes").read_text())
        network = {"interface": interface, "down_rate": None, "up_rate": None}

        # Rates from the counters at the last reading. A counter that went down (another interface, a disk
        # that came and went) gives no rate this once.
        if last is not None and now > last["time"]:
            seconds = now - last["time"]
            if disk_read >= last["disk_read"] and disk_write >= last["disk_write"]:
                disk["read_rate"] = (disk_read - last["disk_read"]) / seconds
                disk["write_rate"] = (disk_write - last["disk_write"]) / seconds
            if interface is not None and interface == last["interface"] and net_down >= last["net_down"] and net_up >= last["net_up"]:
                network["down_rate"] = (net_down - last["net_down"]) / seconds
                network["up_rate"] = (net_up - last["net_up"]) / seconds
        self.last = {
            "time": now,
            "cpu": times,
            "disk_read": disk_read,
            "disk_write": disk_write,
            "interface": interface,
            "net_down": net_down,
            "net_up": net_up,
        }

        # Battery and charger. power_now is in µW; some batteries only give current (µA) and voltage (µV).
        found_battery = None
        plugged_in = None
        for supply in sorted(Path("/sys/class/power_supply").iterdir()):
            kind = (supply / "type").read_text().strip()
            if kind == "Mains":
                plugged_in = (supply / "online").read_text().strip() == "1"
            if kind == "Battery" and found_battery is None and (supply / "capacity").exists():
                found_battery = supply
        battery = None
        if found_battery is not None:
            power_w = None
            if (found_battery / "power_now").exists():
                power_w = int((found_battery / "power_now").read_text()) / 1e6
            elif (found_battery / "current_now").exists() and (found_battery / "voltage_now").exists():
                power_w = int((found_battery / "current_now").read_text()) * int((found_battery / "voltage_now").read_text()) / 1e12
            battery = {
                "percent": int((found_battery / "capacity").read_text()),
                "status": (found_battery / "status").read_text().strip(),
                "power_w": power_w,
                "plugged_in": plugged_in,
            }

        fans = [int(path.read_text()) for path in self.fans]

        return {"cpu": cpu, "memory": memory, "gpus": gpus, "disk": disk, "network": network, "battery": battery, "fans": fans}

    def read_gpu(self, found: dict) -> dict:
        """One GPU's numbers, without waking it (see the top of this file)."""
        device = found["device"]
        gpu = {
            "address": device.name,
            "vendor": found["vendor"],
            "name": found["name"],
            "state": "unknown",
            "percent": None,
            "memory_used_gb": None,
            "memory_total_gb": None,
            "shared_used_gb": None,
            "shared_total_gb": None,
            "temp_c": None,
            "power_w": None,
            "mhz": None,
        }
        driver = ""
        if (device / "driver").exists():
            driver = os.path.basename(os.readlink(device / "driver"))
        if driver == "vfio-pci":
            gpu["state"] = "in_vm"
            return gpu

        if found["vendor"] == "nvidia":
            if driver != "nvidia":
                gpu["state"] = "no_driver"
                return gpu
            if (device / "power/runtime_status").read_text().strip() == "suspended":
                gpu["state"] = "asleep"
                return gpu
            if self.watchers == 0:
                gpu["state"] = "not_watched"
                return gpu
            query = "name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,clocks.gr"
            try:
                result = subprocess.run(
                    ["nvidia-smi", f"--id={device.name}", f"--query-gpu={query}", "--format=csv,noheader,nounits"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                values = [value.strip() for value in result.stdout.strip().split(",")]
            except Exception:
                values = []
            if len(values) != 7:
                gpu["state"] = "error"
                return gpu
            # "[N/A]" for what this GPU doesn't report.
            numbers = [float(value) if value.replace(".", "").isdigit() else None for value in values[1:]]
            # The driver's name is the one on the box ("NVIDIA GeForce RTX 3060"): kept for when it sleeps.
            found["name"] = values[0]
            gpu["name"] = values[0]
            gpu["state"] = "on"
            gpu["percent"] = numbers[0]
            gpu["memory_used_gb"] = numbers[1] * 1024**2 / GB if numbers[1] is not None else None
            gpu["memory_total_gb"] = numbers[2] * 1024**2 / GB if numbers[2] is not None else None
            gpu["temp_c"] = numbers[3]
            gpu["power_w"] = numbers[4]
            gpu["mhz"] = numbers[5]
            return gpu

        if found["vendor"] == "amd" and driver == "amdgpu":
            gpu["state"] = "on"
            gpu["percent"] = int((device / "gpu_busy_percent").read_text())
            gpu["memory_used_gb"] = int((device / "mem_info_vram_used").read_text()) / GB
            gpu["memory_total_gb"] = int((device / "mem_info_vram_total").read_text()) / GB
            gpu["shared_used_gb"] = int((device / "mem_info_gtt_used").read_text()) / GB
            gpu["shared_total_gb"] = int((device / "mem_info_gtt_total").read_text()) / GB
            for hwmon in (device / "hwmon").iterdir():
                if (hwmon / "temp1_input").exists():
                    gpu["temp_c"] = int((hwmon / "temp1_input").read_text()) / 1000
                if (hwmon / "freq1_input").exists():
                    gpu["mhz"] = int((hwmon / "freq1_input").read_text()) / 1e6
                # Built-in graphics report the whole chip's power ("PPT", CPU too), so only a card's own counts.
                if (hwmon / "power1_input").exists() and (hwmon / "power1_label").read_text().strip() != "PPT":
                    gpu["power_w"] = int((hwmon / "power1_input").read_text()) / 1e6
            return gpu

        return gpu
