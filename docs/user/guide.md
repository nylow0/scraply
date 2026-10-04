# Use Scraply

Use **Setup** for the brief and research settings, **Research** for evidence, and **Solutions** for the resulting ideas. Work is saved locally. Reopening a project reads its saved state; it does not start another model or search request.

While a run is active, its progress and the Pause and Stop controls sit above every tab. When it finishes, **Run details** at the bottom of Solutions keeps its model calls, searches, time taken, saved tasks, and the session ID. The step-by-step trace of a run is a file for debugging, not a screen: copy the session ID from Run details and give it to an agent, which can write the trace with `bun scripts/trace.ts <session ID>` from a Scraply checkout.

## Start a project

1. Connect an OpenAI account in Scraply. For web discovery, add an Exa or Perplexity API key too. The welcome prompt asks for both after you sign in, and **Settings → Accounts** can add, replace, or remove a key later. Scraply checks each key with its provider before saving it and afterwards shows only its last four characters. Selectable models come from the connected account's live catalog.
2. Create a project. Choose **Find problems to solve** to research a topic or audience, or **I have a problem to solve** when you can state the problem already. A known-problem run can skip web search.
3. Write what you want to explore or state your known problem. Add the intended audience, boundaries, and any risks you want evaluated. Choose the model and reasoning effort, research depth, and search provider when discovery needs them. **Auto** uses the available providers for the sources each search needs.
4. Choose how much supervision you want. **Controlled** first pauses for you to review the research frame, then pauses again after research. **Vibe** asks for the idea model before launch and approves the frame automatically, recording unanswered questions before proceeding.
5. Check the depth and **Solutions per problem** (1 to 5, default 3) before starting. Each selected problem gets up to that many ideas.

The project saves the resolved instructions and chosen model settings with each run. You can edit advanced instructions for research, generation, or review before launch. Existing `prompts/workflow-v2-*.md` overrides remain available for deeper customization; see [data and privacy](data-and-privacy.md#prompt-overrides-and-saved-runs).

The frame records the goal, success criteria, constraints, research areas, source venues, and languages. In Controlled mode, edit these before starting research, answer useful open questions, or regenerate the draft with one model call. English stays included; you can add up to two other languages. A known-problem frame has no research areas and can proceed without search. Editing an approved frame creates a new version for future work. Earlier runs keep the version they used.

## Models and research depth

Scraply's selectors can show GPT-6 Astra, Sol, and Luna when the connected account's live catalog offers them. Reasoning choices depend on the selected model. A saved model or effort that is no longer available remains visible so you can replace it deliberately; Scraply does not silently choose another one. Controlled lets you choose the ideas model after research. Vibe needs it before Start because no selection dialog interrupts that run.

**Quick**, **Standard**, and **Deep** guide the breadth and thoroughness of the same research stages. New runs do not stop because they reach an estimated call count, search count, or elapsed duration. Idea requests wait for their response, a provider or connection error, or your cancellation. A research request that runs far longer than usual is stopped and tried once more; evidence reading instead splits its sources into smaller reads, and a source that still cannot be read is skipped and noted in the activity list. If a model answer fails in one research area, that area finishes early, keeps the problems it already checked, and the other areas continue. You can pause before the next task or stop current work. Older saved runs retain their call and search limits. Usage stays marked unknown when the provider does not report it.

## Controlled research

Research lists the problems it confirmed, and the ones you stated, with cited factors and source links. Read the excerpt and open its source before treating a claim as established. A matched excerpt supports only what it actually says. Model confidence is uncalibrated, and a problem's presence does not prove customer demand. A problem is confirmed by two independent firsthand or measured accounts from the people you described or from people in a close role doing the same task, such as bookkeepers at a small firm for a freelance-bookkeeper brief. When it needed close roles, the problem shows **Evidence from close roles**.

At the checkpoint, you can select the problems worth developing and choose the idea-generation model and effort. You can also request more research. A new question adds a named request; extra threads investigate different angles inside that request. From a finding, ask Scraply to search for new evidence or reevaluate saved evidence. A redo keeps the earlier finding in the archive. Compare the claims and sources, then choose whether the new result becomes the active evidence snapshot. A failed or unapplied redo leaves the current snapshot in place.

Everything else is a lead, behind **Show N more leads**. Each lead says why it is not a problem: **Needs more evidence**, **Not checked yet**, or **Ruled out**. Only problems get ideas. Leads beyond the depth's checking limit are **Not checked yet**; **Check this lead** shows the calls and searches the check may use, and **Start check** runs it with the lead's saved evidence. If the remaining allowance is too small, the lead stays available to check later.

Generation uses the active evidence snapshot. Check which research updates you applied before generating. A pending or unapplied request stays outside that snapshot, so you can continue with the current research or wait and apply its result. Changing active research does not rewrite old ideas. Those ideas still point to the evidence used when they were made.

For a known problem, you can enter it at the checkpoint and proceed without pretending that Scraply discovered evidence for it. Exploratory startup hypotheses are also an explicit setup choice and retain their exploratory origin.

## Vibe runs

Vibe develops every evidence-qualified problem and records why it chose each one. Problems describing the same workflow, or resting on exactly the same sources, are developed once. To develop fewer, set **Problems to develop** under Limits before Start; the strongest fit to the brief and buyer goes first. It can return research with zero ideas if no problem qualifies. It does not turn rejected evidence into a supported claim.

During discovery, the progress view shows recent research actions, including search queries, returned source counts, and evidence processing. This activity is saved and returns when you reopen the research. Run details contain usage and individual tasks. Pause and Stop remain directly accessible while research runs. Closing the app or putting the machine to sleep does not promise background progress. Reopening reads the saved result and offers continuation only when the remaining work is safe to resume.

New research scans the included areas, then investigates the strongest areas in more depth. Each investigator shows its current step and confirmed, insufficient, and dropped findings. Standard investigates three areas and Deep four. They search for more evidence only for a finding that is one independent source short of confirmation. The run can finish with a partial set when further checks do not establish enough evidence.

A settled Vibe run opens the idea collection. It may contain the target, a useful partial set, or zero qualifying ideas. A provider or authentication failure should end with the work saved and a reason you can act on. A request with an unknown completion is conservatively counted. If the connection drops during a model call, Scraply waits a few seconds, starts that call over, and records the lost attempt in the run trace. It tries up to twice. If the call drops a third time during research, only that research area stops; its checked problems are kept and the run continues.

If it drops three times while ideas are written or ranked, the run stops: open **Run details** at the bottom of Solutions, then **Task details**. Review the warning before choosing **Retry task**. The retry starts a separate attempt at that task and can incur additional provider usage; the original run remains saved. New depth-guided research reads evidence in smaller batches, with batch progress in the activity list.

After a Vibe run finishes, open **Research** to ask a separate question or revisit a finding. This starts a new, explicitly limited research follow-up; it does not reopen the finished Vibe run or change its recorded idea count. Compare the result before applying it to a new evidence snapshot. The original ideas stay saved.

## Review ideas and explore one

For each selected problem, one call writes all of its ideas so they can differ from each other, and a second call ranks them from best to worst against your brief and success criteria. A problem can end with fewer ideas than you asked for; Scraply never pads the count. The Solutions page shows one group per problem, best idea first. An idea is marked **Weak fit** and moved to the end of its group when it clearly fails a must-have criterion or nearly repeats a higher idea; an unknown criterion never makes an idea weak. Open the idea to read why it is ranked where it is. Projects from earlier versions keep their saved order and review labels.

Open an idea to read its evidence, assumptions, risks, and possible consequences. A source citation means the saved excerpt can be traced, not that the proposed business outcome has happened. The independent risk evaluation is a model judgment. Record your own decision and any real-world test outcome separately.

Ideas from framed research show their fit against each success criterion, the larger problem, a feasible slice, and a first test suited to the goal. Older ideas without these assessments remain readable.

The idea's conversation can explain the saved rationale, discuss other directions, or rethink the mechanism. A rethink saves a linked version. Earlier versions, their evidence snapshots, and their reviews remain readable. A conversation reply by itself does not add an idea to the collection. Revising an idea does not make an earlier risk review apply to the new version.

By default, a reply uses the selected version's saved research. If you applied later research, check **Use newer research** before sending a reply that should consider the current snapshot. The reply records the snapshot it used. A rethink based on it creates a new version while the earlier idea, conversation, and evidence stay in history. Compare versions in the idea view; changing the selected version does not rerun the model.

For a selected startup idea, Scraply can draft a focused experiment and review whether it tests one assumption. The draft specifies a metric, baseline, eligible cases, observation window, outcome rules, and spending limit. A review may mark it **needs revision**. A generated plan is not a customer experiment that has been run; check its thresholds before using it. If one decisive fact is missing, you can request one evidence follow-up for that run. Completed and failed follow-ups both consume its one-question limit.

Numeric plans declare the metric's possible range. Pass thresholds include equality; fail thresholds exclude equality. With a nonnegative percentage, "below 1% fails" includes zero, while "below 0% fails" is impossible and is rejected. Too few usable observations remain inconclusive. Saved plans keep their original thresholds, and older numeric plans without recorded bounds show a review reminder. The independent semantic review checks the plan's assumptions, but it cannot prove that an experiment is good.

## Saved work and exports

Saved v1 projects remain readable and exportable. New research uses the current workflow, including when started from an old project's setup. A saved run resumes with its original instructions; start a new run to use changed setup or prompt overrides. An unknown dispatched completion blocks automatic replay.

New development runs can include recorded observations from earlier completed experiments on the same problem in the same project. Scraply labels them as your reports, with the original mechanism and decision attached. The run snapshots up to five recent results and 12,000 characters; later edits do not rewrite that snapshot.

Export research as JSON and ideas or analyses as Markdown or JSON. Idea exports include saved version lineage, conversation turns, and evidence snapshot references where present. Exported files are portable records, not a full backup of the project database. [Data and privacy](data-and-privacy.md) explains full backups, local logs, credentials, and what gets sent to providers. [Troubleshooting](troubleshooting.md) covers interrupted and partial runs.
