<script lang="ts">
  import type { ComponentProps } from "svelte";
  import SolutionWorkspace from "../../src/renderer/components/SolutionWorkspace.svelte";
  import type { SolutionsRoute } from "../../src/renderer/lib/navigation-history";

  type WorkspaceProps = ComponentProps<typeof SolutionWorkspace>;
  let {
    onNavigate,
    onBack,
    ...props
  }: Omit<WorkspaceProps, "route" | "onNavigate" | "onBack"> & {
    onNavigate?: WorkspaceProps["onNavigate"];
    onBack?: WorkspaceProps["onBack"];
  } = $props();

  // Own only the route. Loading and errors are supplied by the test, as App supplies them in production.
  let route = $state<SolutionsRoute>({ kind: "list" });
</script>

<SolutionWorkspace {...props} {route}
  onNavigate={(next) => { onNavigate?.(next); route = next; }}
  onBack={(parent) => { onBack?.(parent); route = parent; }} />
