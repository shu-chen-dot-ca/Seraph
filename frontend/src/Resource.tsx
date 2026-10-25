/*
The Resource pages, from the sidebar's Resource line (under the VMs, below a line) and its GPU child. Not built yet:
both only say what will be here.
- #/resource: this computer's use, CPU, RAM, GPUs, disk, network and battery, and what each running VM takes.
- #/resource/gpu: the computer's NVIDIA GPU, and a button to give it to a VM (the desktop keeps running on the
  built-in AMD graphics) and to take it back.
*/

export default function Resource(props: { selected: string | null }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center border-b px-3 font-medium">{props.selected === "gpu" ? "GPU" : "Resource"}</div>
      {props.selected === "gpu" ? (
        <div className="px-3 py-2 text-muted-foreground">Not built yet. Here you will give the NVIDIA GPU to a VM, and take it back.</div>
      ) : (
        <div className="px-3 py-2 text-muted-foreground">Not built yet. Here you will see this computer's CPU, RAM, GPU, disk and network use.</div>
      )}
    </div>
  );
}
