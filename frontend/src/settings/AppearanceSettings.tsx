import { Check, Moon, Sun, SunMoon, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/*
Theme (Light, Dark or System) and accent color. They show right away and are kept in this browser: App owns them,
puts them on <html> (class "dark" and data-accent) and keeps them in localStorage; index.html applies the saved ones
before the first paint. Each theme card has a tiny drawing of the app in that theme; System's is split corner to
corner. The accent colors live in index.css; a swatch carries data-accent itself, so it shows that color as it looks
in the current theme.
*/

export type ThemeMode = "light" | "dark" | "system";

const MODES: { id: ThemeMode; label: string; icon: LucideIcon }[] = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: SunMoon },
];

const ACCENTS = [
  { id: "blue", name: "Blue" },
  { id: "indigo", name: "Indigo" },
  { id: "violet", name: "Violet" },
  { id: "pink", name: "Pink" },
  { id: "orange", name: "Orange" },
  { id: "green", name: "Green" },
  { id: "teal", name: "Teal" },
  { id: "coral", name: "Coral" },
  { id: "graphite", name: "Graphite" },
];

export default function AppearanceSettings(props: { theme: ThemeMode; onTheme: (theme: ThemeMode) => void; accent: string; onAccent: (accent: string) => void }) {
  const accentName = ACCENTS.find((each) => each.id === props.accent)?.name ?? "";
  return (
    <>
      <section>
        <div className="mb-2 font-medium">Theme</div>
        <div className="grid grid-cols-3 gap-2.5">
          {MODES.map((mode) => {
            const selected = props.theme === mode.id;
            // System draws both: the light app, and the dark one over its lower-right half.
            const layers = mode.id === "system" ? ["light", "dark"] : [mode.id];
            return (
              <button
                key={mode.id}
                type="button"
                aria-pressed={selected}
                onClick={() => props.onTheme(mode.id)}
                className={cn(
                  "rounded-lg border bg-card p-1.5 text-left transition-colors hover:border-ring/60",
                  selected && "border-primary ring-1 ring-primary hover:border-primary",
                )}
              >
                <div className="relative h-16 overflow-hidden rounded-md border">
                  {layers.map((layer) => {
                    const dark = layer === "dark";
                    return (
                      <div
                        key={layer}
                        className={cn(
                          "absolute inset-0 flex",
                          dark ? "bg-[#0e1015]" : "bg-[#faf9f7]",
                          mode.id === "system" && dark && "[clip-path:polygon(100%_0,100%_100%,0_100%)]",
                        )}
                      >
                        <div className={cn("w-1/3 space-y-1 border-r p-1.5", dark ? "border-[#20232c] bg-[#111319]" : "border-[#e8e4dc] bg-[#f4f1ec]")}>
                          <div className="h-1.5 rounded-full bg-primary/70" />
                          <div className={cn("h-1.5 rounded-full", dark ? "bg-[#2e3040]" : "bg-[#e8e4dc]")} />
                          <div className={cn("h-1.5 rounded-full", dark ? "bg-[#2e3040]" : "bg-[#e8e4dc]")} />
                          <div className={cn("h-1.5 w-2/3 rounded-full", dark ? "bg-[#2e3040]" : "bg-[#e8e4dc]")} />
                        </div>
                        <div className="flex-1 space-y-1.5 p-2">
                          <div className={cn("h-1.5 w-3/4 rounded-full", dark ? "bg-[#55586a]" : "bg-[#d6d0c5]")} />
                          <div className={cn("h-1.5 w-full rounded-full", dark ? "bg-[#2e3040]" : "bg-[#e8e4dc]")} />
                          <div className={cn("h-1.5 w-1/2 rounded-full", dark ? "bg-[#2e3040]" : "bg-[#e8e4dc]")} />
                          <div className="h-2.5 w-7 rounded-sm bg-primary" />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-1.5 flex items-center gap-1.5 px-0.5">
                  <mode.icon className="size-3.5 text-muted-foreground" />
                  {mode.label}
                  {selected && <Check className="ml-auto size-3.5 text-primary" />}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <span className="font-medium">Accent color</span>
          <span className="text-muted-foreground">{accentName}</span>
        </div>
        <div className="flex flex-wrap gap-2.5">
          {ACCENTS.map((each) => {
            const selected = props.accent === each.id;
            return (
              <button
                key={each.id}
                type="button"
                data-accent={each.id}
                title={each.name}
                aria-label={each.name}
                aria-pressed={selected}
                onClick={() => props.onAccent(each.id)}
                className={cn(
                  "flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground ring-offset-2 ring-offset-popover transition-shadow hover:ring-2 hover:ring-primary/40",
                  selected && "ring-2 ring-primary hover:ring-primary",
                )}
              >
                {selected && <Check className="size-3.5" strokeWidth={3} />}
              </button>
            );
          })}
        </div>
      </section>
    </>
  );
}
