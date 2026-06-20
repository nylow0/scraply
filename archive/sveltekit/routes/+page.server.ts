import { env } from "$env/dynamic/private";
import { fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { createProductionTreeService } from "../mcp/server";
import { actionError, createDiveFromForm, loadWorkspaceView, rateIdeaFromForm } from "$lib/server/workspace";

const service = createProductionTreeService(env);

export const load: PageServerLoad = async ({ url }) => {
  try {
    return { workspace: await loadWorkspaceView(service, url.searchParams.get("node")), workspaceError: null };
  } catch (error) {
    return { workspace: null, workspaceError: actionError(error) };
  }
};

export const actions: Actions = {
  rate: async ({ request }) => {
    try {
      const idea = await rateIdeaFromForm(service, await request.formData());
      return { success: true, message: `Rating saved for ${idea.title}.` };
    } catch (error) {
      return fail(400, { success: false, ...actionError(error) });
    }
  },
  dive: async ({ request }) => {
    try {
      const result = await createDiveFromForm(service, await request.formData());
      if (!result.researchStarted) {
        return {
          success: true,
          warning: true,
          childId: result.child.id,
          message: "The child branch was created, but research did not start.",
          detail: result.researchError,
        };
      }
      return { success: true, childId: result.child.id, message: "The deeper branch was created and researched." };
    } catch (error) {
      return fail(400, { success: false, ...actionError(error) });
    }
  },
  research: async ({ request }) => {
    const id = String((await request.formData()).get("id") ?? "");
    try {
      await service.researchNode(id);
      return { success: true, message: "Research completed for this branch." };
    } catch (error) {
      return fail(502, { success: false, ...actionError(error) });
    }
  },
};
