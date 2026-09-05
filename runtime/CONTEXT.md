# Scraply runtime

The Scraply runtime performs one bounded stage assignment through a user-selected model. Scraply remains the owner of the workflow and its research.

## Language

**Runtime**:
The local process that accepts stage assignments and returns validated model results with accounting data.
_Avoid_: Harness, agent, Codex runtime

**Work order**:
One bounded assignment for a Scraply workflow stage, including its goal, inputs, required decisions, completion conditions, and constraints.
_Avoid_: Task, job, prompt

**Evidence**:
Untrusted research material attached to a work order and identified by stable source IDs owned by Scraply.
_Avoid_: Context, tool output

**Provider**:
A billing and authentication route through which the runtime reaches models.
_Avoid_: Backend, gateway when referring to the general concept

**Qualified model**:
A model identified together with its provider. The same model name through two providers names two qualified models.
_Avoid_: Bare model, fallback model

**Provider account**:
A user's authenticated relationship with one provider.
_Avoid_: Account when the provider is unclear

**Credential session**:
The in-memory credentials supplied by Scraply for the current runtime session.
_Avoid_: Credential store, auth file

**Generation**:
One provider call sequence for a work order, including at most one explicitly authorized schema repair.
_Avoid_: Agent turn, tool loop
