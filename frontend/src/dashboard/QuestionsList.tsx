import DataList from "@/components/DataList";
import { Badge } from "@/components/ui/badge";
import { since, useNow } from "@/components/ui/job-progress";
import { useLive, type Draft } from "@/live";
import { questionWhen } from "@/model/inbox";
import { href } from "@/routes";

/*
The Dashboard's Questions: an agent asked you something. The ones with a timer say when the agent goes ahead with its
recommended choice; the others wait for you. Answered one at a time, on the question's page.
*/

export default function QuestionsList(props: { questions: Draft[] }) {
  const agents = useLive("agents");
  const now = useNow();
  const agentName = (id: string | null) => agents.find((agent) => agent.id === id)?.name ?? id ?? "";

  return (
    <DataList
      id="inbox-questions"
      rows={props.questions}
      rowId={(draft) => draft.id}
      rowHref={(draft) => href.inboxItem(draft.id)}
      defaultSort={{ key: "asked", dir: -1 }}
      empty="No questions. No agent is waiting on you."
      search={(draft) => `${draft.title} ${draft.repo ?? ""} ${agentName(draft.agent)}`}
      columns={[
        { key: "ask", label: "Question", main: true, sortValue: (draft) => draft.title, cell: (draft) => draft.title },
        {
          key: "when",
          label: "Goes ahead",
          sortValue: (draft) => draft.answer_by ?? "z",
          cell: (draft) => <Badge variant={draft.answer_by ? "secondary" : "warn"}>{questionWhen(draft, now)}</Badge>,
        },
        { key: "agent", label: "Agent", sortValue: (draft) => agentName(draft.agent), cell: (draft) => agentName(draft.agent) },
        { key: "project", label: "Project", sortValue: (draft) => draft.target ?? draft.repo ?? "", cell: (draft) => draft.target ?? draft.repo ?? "" },
        { key: "asked", label: "Asked", time: true, sortValue: (draft) => draft.created_at, cell: (draft) => `${since(draft.created_at, now)} ago` },
      ]}
      bulk={() => []}
    />
  );
}
