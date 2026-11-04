import About from "@/About";
import PageHeader from "@/components/PageHeader";
import RemoteAccess from "@/RemoteAccess";
import { href } from "@/routes";
import AppearanceSettings, { type ThemeMode } from "@/settings/AppearanceSettings";
import AskSettings from "@/settings/AskSettings";
import EnvSettings from "@/settings/EnvSettings";
import GitHubAccountSettings from "@/settings/GitHubAccountSettings";

/*
Settings, from your picture at the top right: your GitHub account, when agents ask you, the theme and accent, the env
vars for all VMs, this computer's usage, Remote access (the address for your phone and the devices that may sign in
there) and About (the version that runs, Check for updates, Previous version).
*/

export default function SettingsPage(props: { theme: ThemeMode; onTheme: (theme: ThemeMode) => void; accent: string; onAccent: (accent: string) => void }) {
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="flex max-w-2xl flex-col gap-8 p-4 pb-16">
        <GitHubAccountSettings />
        <AskSettings />
        <AppearanceSettings theme={props.theme} onTheme={props.onTheme} accent={props.accent} onAccent={props.onAccent} />
        <EnvSettings />
        <section>
          <div className="mb-1 font-medium">This computer</div>
          <a href={href.machines("resource")} className="text-primary hover:underline">
            Its CPU, memory, disk and graphics card →
          </a>
        </section>
        <RemoteAccess open />
        <About />
      </div>
    </div>
  );
}
