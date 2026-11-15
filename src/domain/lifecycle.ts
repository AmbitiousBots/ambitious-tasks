import { err, ok, type Result, type Status, type StatusChange } from "./types.ts";

export type TransitionError = {
  readonly code: "E_TRANSITION";
  readonly message: string;
};

export const parseStatusChange = (
  from: Status,
  to: Status,
  reopen = false,
): Result<StatusChange | null, TransitionError> => {
  if (from === to && !reopen) return ok(null);
  if (reopen) {
    return from === "done" && to === "todo"
      ? ok({ kind: "reopen", from, to })
      : err({ code: "E_TRANSITION", message: "Reopen changes a done task to todo." });
  }
  if (from === "done") {
    return err({ code: "E_TRANSITION", message: "A done task must be explicitly reopened before its status changes." });
  }
  switch (from) {
    case "todo": return to === "todo" ? ok(null) : ok({ kind: "set", from, to });
    case "in_progress": return to === "in_progress" ? ok(null) : ok({ kind: "set", from, to });
    case "blocked": return to === "blocked" ? ok(null) : ok({ kind: "set", from, to });
    case "waiting": return to === "waiting" ? ok(null) : ok({ kind: "set", from, to });
    case "canceled": return to === "canceled" ? ok(null) : ok({ kind: "set", from, to });
  }
};
