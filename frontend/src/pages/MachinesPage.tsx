import PageHeader from "@/components/PageHeader";
import Resource from "@/Resource";
import { href } from "@/routes";
import VMs from "@/VMs";

/*
Machines: the VMs (VMs.tsx, with its Images and Defaults tabs), and this computer's own usage (Resource.tsx, ?tab=resource,
linked from Settings). One VM's page (VMPage.tsx) is App's: it stays mounted while you are elsewhere, so its desktop
keeps its connection.
*/

export default function MachinesPage(props: { tab: string | null }) {
  if (props.tab === "resource") {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          back
          title="This computer"
          right={
            <a href={href.machines()} className="text-primary hover:underline">
              VMs
            </a>
          }
        />
        <div className="min-h-0 flex-1">
          <Resource />
        </div>
      </div>
    );
  }
  const tab = props.tab === "images" || props.tab === "defaults" ? props.tab : "vms";
  return <VMs tab={tab} />;
}
