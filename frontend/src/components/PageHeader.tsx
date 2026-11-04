import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

// The row at the top of every page: Back (on one thing's page), its name, a line under it, and its actions.
export default function PageHeader(props: { title: string; meta?: ReactNode; right?: ReactNode; back?: boolean }) {
  return (
    <div className="sticky top-0 z-10 flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b bg-background px-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {props.back && (
          <Button variant="ghost" size="icon-sm" className="-ml-1.5" aria-label="Back" onClick={() => history.back()}>
            <ArrowLeft />
          </Button>
        )}
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{props.title}</h1>
          {props.meta && <div className="text-xs text-muted-foreground">{props.meta}</div>}
        </div>
      </div>
      {props.right}
    </div>
  );
}
