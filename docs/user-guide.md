# Use Scraply

Scraply keeps a project in three places: **Setup** for the brief and limits, **Research** for evidence, and **Ideas** for the resulting options. Work is saved locally. Reopening a project reads its saved state; it does not start another model or search request.

## Start a project

1. Connect an OpenAI account in Scraply. For web discovery, connect Exa or Perplexity too. Selectable models come from the connected account's live catalog.
2. Create a project. Choose **Find problems to solve** to research a topic or audience, or **I have a problem to solve** when you can state the problem already. A known-problem run can skip web search.
3. Write what you want to explore or state your known problem. Add the intended audience, boundaries, and any risks you want evaluated. Choose the model and reasoning effort, research depth and search provider when discovery needs them.
4. Choose how much supervision you want. **Babysit** stops after research for your review. **Vibe** asks for the idea model and limits before launch, then advances through research, selection, generation, and review while the local app host remains open.
5. Check the target and limits before starting. **Solutions per problem** controls each generation batch. For startup opportunities, **Build a project-wide set of distinct businesses** enables a separate **Distinct family target**. It counts accepted, independent business families, not every variant. A higher target can take more calls and may finish short when evidence or limits run out.

The project saves the resolved instructions and chosen model settings with each run. You can edit advanced instructions for research, generation, or review before launch. Existing `prompts/workflow-v2-*.md` overrides remain available for deeper customization; see [data and privacy](data-and-privacy.md#prompt-overrides-and-saved-runs).

## Models and limits

Scraply's selectors can show GPT-6 Astra, Sol, and Luna when the connected account's live catalog offers them. Reasoning choices depend on the selected model. A saved model or effort that is no longer available remains visible so you can replace it deliberately; Scraply does not silently choose another one. Babysit lets you choose the ideas model after research. Vibe needs it before Start because no selection dialog interrupts that run.

The setup limits bound planned model calls, searches, and elapsed work. Review the preview after changing a limit. Native OpenAI subscription calls do not support an output-token ceiling, so a request deadline and output-size limit cannot guarantee a token or billing ceiling. Usage stays marked unknown when the provider does not report it.

## Babysit research

Research presents candidate problems with cited factors and source links. Read the excerpt and open its source before treating a claim as established. A matched excerpt supports only what it actually says. Model confidence is uncalibrated, and a problem's presence does not prove customer demand.

At the checkpoint, you can select the problems worth developing and choose the idea-generation model and effort. You can also request more research. A new question adds a named request; extra threads investigate different angles inside that request. From a finding, ask Scraply to search for new evidence or reevaluate saved evidence. A redo keeps the earlier finding in the archive. Compare the claims and sources, then choose whether the new result becomes the active evidence snapshot. A failed or unapplied redo leaves the current snapshot in place.

Generation uses the active evidence snapshot. Check which research updates you applied before generating. A pending or unapplied request stays outside that snapshot, so you can continue with the current research or wait and apply its result. Changing active research does not rewrite old ideas. Those ideas still point to the evidence used when they were made.

For a known problem, you can enter it at the checkpoint and proceed without pretending that Scraply discovered evidence for it. Exploratory startup hypotheses are also an explicit setup choice and retain their exploratory origin.

## Vibe runs

Vibe selects evidence-qualified problems and records why it chose them. Discovery favors fit to the brief and buyer, direct evidence, and distinct workflows. It can return research with zero ideas if no problem qualifies. It does not turn rejected evidence into a supported claim.

The progress view shows the current stage, accepted ideas versus the target, saved work, and remaining calls, searches, and time. Task details show individual research questions or generation assignments. The app can pause before the next assignment or request cancellation of dispatched work. Closing the app or putting the machine to sleep does not promise background progress. Reopening reads the saved result and offers continuation only when the remaining work is safe to resume.

A settled Vibe run opens the idea collection. It may contain the target, a useful partial set, or zero qualifying ideas. A provider or authentication failure should end with the work saved and a reason you can act on. A request with an unknown completion is conservatively counted and is not silently replayed.

After a Vibe run finishes, open **Research** to ask a separate question or revisit a finding. This starts a new, explicitly limited research follow-up; it does not reopen the finished Vibe run or change its recorded idea count. Compare the result before applying it to a new evidence snapshot. The original ideas stay saved.

## Review ideas and explore one

Scraply aims for distinct, eligible ideas, then makes at most two fill rounds, split into small assigned batches, within the saved budget. It never pads the count. Review the accepted count, the requested count, unresolved comparisons, and the stopping reason. Variants and duplicates do not count as new business families. The saved-idea review button compares the current collection without generating more options; membership edits keep the original work and append to decision history.

Open an idea to read its evidence, assumptions, risks, and possible consequences. A source citation means the saved excerpt can be traced, not that the proposed business outcome has happened. The independent risk evaluation is a model judgment. Record your own decision and any real-world test outcome separately.

The idea's conversation can explain the saved rationale, discuss other directions, or rethink the mechanism. A rethink saves a linked version. Earlier versions, their evidence snapshots, and their reviews remain readable. A conversation reply by itself does not add an idea to the collection. Revising an idea does not make an earlier risk review apply to the new version.

By default, a reply uses the selected version's saved research. If you applied later research, check **Use newer research** before sending a reply that should consider the current snapshot. The reply records the snapshot it used. A rethink based on it creates a new version while the earlier idea, conversation, and evidence stay in history. Compare versions in the idea view; changing the selected version does not rerun the model.

For a selected startup idea, Scraply can draft a focused experiment and review whether it tests one assumption. The draft specifies a metric, baseline, eligible cases, observation window, outcome rules, and spending limit. A review may mark it **needs revision**. A generated plan is not a customer experiment that has been run; check its thresholds before using it. If one decisive fact is missing, you can request one evidence follow-up for that run. Completed and failed follow-ups both consume its one-question limit.

Numeric plans declare the metric's possible range. Pass thresholds include equality; fail thresholds exclude equality. With a nonnegative percentage, "below 1% fails" includes zero, while "below 0% fails" is impossible and is rejected. Too few usable observations remain inconclusive. Saved plans keep their original thresholds, and older numeric plans without recorded bounds show a review reminder. The independent semantic review checks the plan's assumptions, but it cannot prove that an experiment is good.

## Saved work and exports

Saved v1 projects remain readable and exportable. New research uses the current workflow, including when started from an old project's setup. A saved run resumes with its original instructions; start a new run to use changed setup or prompt overrides. An unknown dispatched completion blocks automatic replay.

New development runs can include recorded observations from earlier completed experiments on the same problem in the same project. Scraply labels them as your reports, with the original mechanism and decision attached. The run snapshots up to five recent results and 12,000 characters; later edits do not rewrite that snapshot.

Export research as JSON and ideas or analyses as Markdown or JSON. Idea exports include saved version lineage, conversation turns, and evidence snapshot references where present. Exported files are portable records, not a full backup of the project database. [Data and privacy](data-and-privacy.md) explains full backups, local logs, credentials, and what gets sent to providers. [Troubleshooting](troubleshooting.md) covers interrupted and partial runs.
