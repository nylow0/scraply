<script lang="ts">
  export type IconName = "search" | "plus" | "arrow" | "brief" | "research" | "ideas" | "check" | "close" | "folder" | "command";
  let { name, size = 18 }: { name: IconName; size?: number } = $props();
  const paths: Record<IconName, string> = {
    search: "m21 21-4.5-4.5M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0",
    plus: "M12 5v14M5 12h14", arrow: "M5 12h14m-5-5 5 5-5 5",
    brief: "M8 3h8v4H8zM8 5H5v16h14V5h-3M8 12h8M8 16h5",
    research: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6M7 10h6M10 7v6",
    ideas: "M9 18h6M10 21h4M8 15a7 7 0 1 1 8 0l-1 3H9l-1-3",
    check: "m5 12 4 4L19 6", close: "m6 6 12 12M6 18 18 6",
    folder: "M3 7V5h6l2 2h10v13H3V7Z",
    command: "M9 9V5a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v14a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2V9",
  };
</script>
<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>

