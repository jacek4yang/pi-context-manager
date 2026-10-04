import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { STACK_INFO } from "./info.ts";

/**
 * pi-context-manager — experimental context management and session continuity.
 *
 * Bootstrap entry (main): registers the status command only. Layers land on
 * feature branches: feat/core-contract, feat/hygiene-recall,
 * feat/provider-native-engine, ...
 */
export default function piContextManager(pi: ExtensionAPI) {
  pi.registerCommand("context-manager", {
    description: "Show pi-context-manager stack status",
    handler: async (_args, ctx) => {
      await ctx.ui.notify(
        "pi-context-manager " +
          STACK_INFO.contractVersion +
          ": bootstrap (layers land on feature branches)",
        "info",
      );
    },
  });
}
