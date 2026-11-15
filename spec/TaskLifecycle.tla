---- MODULE TaskLifecycle ----
EXTENDS TLC

CONSTANTS Tasks

VARIABLES replayed, lastEvent, lastTaskWasDone, status, deps, offered

vars == <<replayed, lastEvent, lastTaskWasDone, status, deps, offered>>
eventLog == <<replayed, lastEvent, lastTaskWasDone>>

OpenStatuses == {"todo", "in_progress", "blocked", "waiting"}
Statuses == OpenStatuses \cup {"done", "canceled"}
Absent == "absent"

Created(t) == [kind |-> "created", task |-> t]
StatusSet(t, s, reopen) == [kind |-> "status", task |-> t, status |-> s, reopen |-> reopen]
DepAdded(a, b) == [kind |-> "dep_added", task |-> a, on |-> b]
DepRemoved(a, b) == [kind |-> "dep_removed", task |-> a, on |-> b]

NoEvent == [kind |-> "none"]

Events ==
  [kind : {"created"}, task : Tasks]
    \cup [kind : {"status"}, task : Tasks, status : Statuses, reopen : BOOLEAN]
    \cup [kind : {"dep_added", "dep_removed"}, task : Tasks, on : Tasks]

RECURSIVE Closure(_, _)
Closure(d, reached) ==
  LET grown == reached \cup {b \in Tasks : \E a \in reached : <<a, b>> \in d}
  IN IF grown = reached THEN reached ELSE Closure(d, grown)

Reaches(d, a, b) == b \in Closure(d, {c \in Tasks : <<a, c>> \in d})

Blank == [status |-> [t \in Tasks |-> Absent], deps |-> {}]

Apply(s, e) ==
  CASE e.kind = "created" -> [s EXCEPT !.status[e.task] = "todo"]
    [] e.kind = "status" -> [s EXCEPT !.status[e.task] = e.status]
    [] e.kind = "dep_added" -> [s EXCEPT !.deps = @ \cup {<<e.task, e.on>>}]
    [] e.kind = "dep_removed" -> [s EXCEPT !.deps = @ \ {<<e.task, e.on>>}]

AppendEvent(e) ==
  /\ replayed' = Apply(replayed, e)
  /\ lastEvent' = e
  /\ lastTaskWasDone' = (replayed.status[e.task] = "done")

Init ==
  /\ replayed = Blank
  /\ lastEvent = NoEvent
  /\ lastTaskWasDone = FALSE
  /\ status = [t \in Tasks |-> Absent]
  /\ deps = {}
  /\ offered = {}

Add(t) ==
  /\ status[t] = Absent
  /\ AppendEvent(Created(t))
  /\ status' = [status EXCEPT ![t] = "todo"]
  /\ offered' = {}
  /\ UNCHANGED deps

AddDep(a, b) ==
  /\ status[a] # Absent
  /\ status[b] # Absent
  /\ <<a, b>> \notin deps
  /\ a # b
  /\ ~Reaches(deps, b, a)
  /\ AppendEvent(DepAdded(a, b))
  /\ deps' = deps \cup {<<a, b>>}
  /\ offered' = {}
  /\ UNCHANGED status

RemoveDep(a, b) ==
  /\ <<a, b>> \in deps
  /\ AppendEvent(DepRemoved(a, b))
  /\ deps' = deps \ {<<a, b>>}
  /\ offered' = {}
  /\ UNCHANGED status

SetStatus(t, s) ==
  /\ status[t] # Absent
  /\ status[t] # "done"
  /\ status[t] # s
  /\ AppendEvent(StatusSet(t, s, FALSE))
  /\ status' = [status EXCEPT ![t] = s]
  /\ offered' = {}
  /\ UNCHANGED deps

Reopen(t) ==
  /\ status[t] = "done"
  /\ AppendEvent(StatusSet(t, "todo", TRUE))
  /\ status' = [status EXCEPT ![t] = "todo"]
  /\ offered' = {}
  /\ UNCHANGED deps

Ready(t) ==
  /\ status[t] \in OpenStatuses
  /\ \A b \in Tasks : <<t, b>> \in deps => status[b] = "done"

AskNext ==
  /\ offered' = {t \in Tasks : Ready(t)}
  /\ UNCHANGED <<eventLog, status, deps>>

Next ==
  \/ \E t \in Tasks : Add(t)
  \/ \E a, b \in Tasks : AddDep(a, b)
  \/ \E a, b \in Tasks : RemoveDep(a, b)
  \/ \E t \in Tasks, s \in Statuses : SetStatus(t, s)
  \/ \E t \in Tasks : Reopen(t)
  \/ AskNext

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ replayed \in [status : [Tasks -> Statuses \cup {Absent}], deps : SUBSET (Tasks \X Tasks)]
  /\ lastEvent \in Events \cup {NoEvent}
  /\ lastTaskWasDone \in BOOLEAN
  /\ status \in [Tasks -> Statuses \cup {Absent}]
  /\ deps \subseteq Tasks \X Tasks
  /\ \A d \in deps : status[d[1]] # Absent /\ status[d[2]] # Absent
  /\ offered \subseteq Tasks

NoCycle == \A t \in Tasks : ~Reaches(deps, t, t)

NextOnlyUnblocked ==
  \A t \in offered :
    /\ status[t] \notin {Absent, "done", "canceled"}
    /\ ~\E d \in deps : d[1] = t /\ status[d[2]] # "done"

DoneIsTerminalUnlessReopened ==
  (lastEvent.kind = "status" /\ lastTaskWasDone) => lastEvent.reopen

ReplayEqualsState == replayed = [status |-> status, deps |-> deps]

TaskSymmetry == Permutations(Tasks)
====
