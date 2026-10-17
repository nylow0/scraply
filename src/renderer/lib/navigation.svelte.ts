import { tick, untrack } from "svelte";
import type { WorkspaceState } from "../../shared/ipc";
import type { IdeaConversation } from "../../shared/workflow-contracts";
import {
  findHistoryIndex, parentHistory, pushHistory, reconcileHistory, rememberScroll,
  replaceHistory, routeResolver, sameRoute, traverseHistory,
  type NavigationHistory, type NavigationRoute, type SolutionsRoute,
} from "./navigation-history";

type NavigationWorkspace = Readonly<Pick<WorkspaceState,
  | "activeThreadId" | "threads" | "activeWorkflow" | "solutions"
  | "ideaGroups" | "problemCandidates" | "rejectedProblemCandidates"
>>;
type RouteView = Readonly<Omit<NavigationRoute, "solution"> & { solution: Readonly<SolutionsRoute> }>;
type NavigationDependencies = {
  readonly workspace: NavigationWorkspace | null;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly mainContent: HTMLElement | undefined;
  readonly conversation: Readonly<{
    ideaId: string | null;
    loading: boolean;
    epoch: number;
    versions: readonly Pick<IdeaConversation["versions"][number], "solutionId">[];
  }>;
  selectProject(threadId: string): Promise<boolean>;
  isIdeaReadyForScroll(ideaId: string): boolean;
};

// Create once during App initialization. Getters keep accepted data and mounted views live.
export function createNavigation(deps: NavigationDependencies) {
  let route = $state<NavigationRoute>({ threadId: "", step: "setup", settings: false, solution: { kind: "list" } });
  let history = $state<NavigationHistory>({ entries: [], index: -1 });
  let knownIdeas = $state<Record<string, string[]>>({});
  let traversing = $state(false);
  let pendingScroll = $state<{ route: NavigationRoute; scrollTop: number } | null>(null);
  let visit = 0;
  const resolveRoute = $derived(routeResolver(deps.workspace?.threads ?? [], knownIdeas));
  const canBack = $derived(findHistoryIndex(history, -1, resolveRoute) !== -1);
  const canForward = $derived(findHistoryIndex(history, 1, resolveRoute) !== -1);

  function rememberIdeas() {
    const workspace = deps.workspace;
    if (workspace?.activeThreadId) {
      const ids = workspace.solutions.map(idea => idea.id);
      untrack(() => { knownIdeas = { ...knownIdeas, [workspace.activeThreadId!]: ids }; });
    }
  }
  // Accepted solutions must be remembered even while an App action holds the busy flag.
  $effect(rememberIdeas);

  function replaceRoute(target: NavigationRoute) {
    if (!sameRoute(route, target)) {
      pendingScroll = null;
      visit += 1;
      if (route.threadId !== target.threadId) history = replaceHistory(history, target);
      history = reconcileHistory(history, resolveRoute);
      route = target;
    }
    const current = history.entries[history.index];
    if (!current || !sameRoute(current.route, target)) {
      history = replaceHistory(history, target, deps.mainContent?.scrollTop ?? 0);
    }
  }
  // Passive refreshes preserve the user's tab; a changed project chooses its default.
  $effect(() => {
    const workspace = deps.workspace;
    if (deps.loading || deps.busy || traversing || !workspace?.activeThreadId) return;
    const target = route.threadId === workspace.activeThreadId ? resolveRoute(route)
      : { threadId: workspace.activeThreadId, step: defaultStep(workspace), settings: route.settings, solution: { kind: "list" as const } };
    if (target) untrack(() => replaceRoute(target));
  });

  function currentScroll() {
    return pendingScroll && sameRoute(route, pendingScroll.route) ? pendingScroll.scrollTop : deps.mainContent?.scrollTop ?? 0;
  }
  function push(target: NavigationRoute, outgoingScroll = currentScroll()) {
    if (sameRoute(route, target)) return;
    pendingScroll = null;
    history = replaceHistory(history, route, outgoingScroll);
    const scrollTop = route.threadId === target.threadId && route.step === target.step
      && sameRoute({ ...route, settings: target.settings }, target) ? outgoingScroll : 0;
    history = pushHistory(history, target, scrollTop);
    route = target;
    const destinationVisit = ++visit;
    // New-page resets stay immediate, but an abandoned tick cannot reset a newer visit.
    void tick().then(() => {
      if (visit === destinationVisit && sameRoute(route, target) && deps.mainContent) deps.mainContent.scrollTop = scrollTop;
    });
  }
  function navigate(target: NavigationRoute) {
    if (!traversing) push(target);
  }
  async function selectProject(threadId: string) {
    if (!deps.workspace || deps.busy || traversing) return;
    const outgoingScroll = currentScroll();
    const outgoingVisit = visit;
    traversing = true;
    try {
      if (!await deps.selectProject(threadId) || deps.workspace?.activeThreadId !== threadId || outgoingVisit !== visit) return;
      rememberIdeas();
      push({ threadId, step: defaultStep(deps.workspace), settings: false, solution: { kind: "list" } }, outgoingScroll);
    } finally { traversing = false; }
  }
  async function restore(next: NavigationHistory) {
    const entry = next.entries[next.index];
    if (!entry || !deps.workspace || deps.busy || traversing) return false;
    const outgoingVisit = visit;
    traversing = true;
    try {
      if (entry.route.threadId !== deps.workspace.activeThreadId && !await deps.selectProject(entry.route.threadId)) return false;
      if (deps.workspace?.activeThreadId !== entry.route.threadId || outgoingVisit !== visit) return false;
      // Selection effects may not have run yet. Resolve against the accepted project's IDs now.
      rememberIdeas();
      const resolved = resolveRoute(entry.route);
      if (!resolved) return false;
      const reconciled = reconcileHistory(next, resolveRoute);
      const destination = reconciled.entries[reconciled.index];
      if (!destination) return false;
      history = reconciled;
      route = resolved;
      const destinationVisit = ++visit;
      pendingScroll = { route: resolved, scrollTop: destination.scrollTop };
      // Selection and commit are exclusive. Rendering may yield to the next user action.
      return tick().then(() => visit === destinationVisit && sameRoute(route, resolved) && deps.workspace?.activeThreadId === resolved.threadId);
    } finally { traversing = false; }
  }
  async function traverse(direction: -1 | 1) {
    if (deps.busy || traversing) return false;
    const saved = rememberScroll(history, currentScroll());
    return restore(traverseHistory(saved, direction, resolveRoute));
  }
  async function parent(solution: SolutionsRoute) {
    if (deps.busy || traversing) return false;
    const saved = rememberScroll(history, currentScroll());
    return restore(parentHistory(saved, { ...route, solution }, resolveRoute));
  }
  function replaceFromWorkspace(step?: NavigationRoute["step"]) {
    const workspace = deps.workspace;
    if (!workspace) return;
    rememberIdeas();
    replaceRoute({ threadId: workspace.activeThreadId ?? "", step: step ?? defaultStep(workspace), settings: route.settings,
      solution: route.threadId === workspace.activeThreadId ? route.solution : { kind: "list" } });
  }

  function readyForScroll(target: NavigationRoute) {
    if (!sameRoute(route, target) || deps.workspace?.activeThreadId !== target.threadId) return false;
    if (target.step !== "ideas" || target.solution.kind === "list") return true;
    if (target.solution.kind === "idea") return deps.isIdeaReadyForScroll(target.solution.ideaId);
    const conversation = deps.conversation;
    return !conversation.loading && conversation.ideaId === target.solution.ideaId
      && conversation.versions.some(version => version.solutionId === conversation.ideaId);
  }
  // Details and conversations can change page height again during the render tick.
  $effect(() => {
    const pending = pendingScroll;
    if (!pending || !readyForScroll(pending.route)) return;
    const epoch = deps.conversation.epoch;
    void tick().then(() => {
      if (pendingScroll !== pending || !readyForScroll(pending.route) || epoch !== deps.conversation.epoch || !deps.mainContent) return;
      deps.mainContent.scrollTop = pending.scrollTop;
      pendingScroll = null;
    });
  });

  return {
    get route(): RouteView { return route; },
    get canBack() { return canBack; },
    get canForward() { return canForward; },
    get traversing() { return traversing; },
    navigate, selectProject, traverse, parent, replaceFromWorkspace,
  };
}

function defaultStep(state: NavigationWorkspace): NavigationRoute["step"] {
  const thread = state.threads.find(item => item.id === state.activeThreadId);
  const workflow = state.activeWorkflow;
  if (workflow) {
    if (workflow.purpose === "research-followup" || workflow.state === "waiting-for-review") return "research";
    if (workflow.selectedProblemIds.length > 0 && workflow.state === "running") return "ideas";
    if (workflow.mode === "vibe" && (workflow.state === "finished" || workflow.purpose === "known-problem")) return "ideas";
    if (workflow.state === "finished" && (state.solutions.length > 0 || (state.ideaGroups?.length ?? 0) > 0)) return "ideas";
    return "research";
  }
  if (state.solutions.length > 0 || (state.ideaGroups?.length ?? 0) > 0 || thread?.status === "solutions-ready") return "ideas";
  if (thread?.status === "development-running") return "ideas";
  if (thread?.status === "discovery-running" || state.problemCandidates.length > 0 || state.rejectedProblemCandidates.length > 0) return "research";
  return "setup";
}
