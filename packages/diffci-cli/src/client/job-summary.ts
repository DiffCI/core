import type { ObservationReport } from "./report.js";

/** Selected tests listed by name before the rest collapse into a count. */
const MAX_LISTED_TESTS = 20;

/** Inline code that survives any path: no backticks to close it early, no pipes to split a table cell. */
function code(text: string): string {
  return `\`${text.replace(/`/g, "'").replace(/\|/g, "\\|")}\``;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** `DIRECT_IMPORT` reads as "direct import"; prose reasons pass through. */
function readableReason(reason: string): string {
  return /^[A-Z0-9_]+$/.test(reason) ? reason.toLowerCase().replace(/_/g, " ") : reason;
}

/**
 * The GitHub job summary for `diffci observe`: the place most people will ever read a report, so it
 * leads with the answer (what this change affects) and keeps the full text summary one click away.
 * It claims nothing the report doesn't: no savings, and every fallback and refusal says so.
 */
export function formatJobSummary(report: ObservationReport, textSummary: string, delivery?: string): string {
  const lines: string[] = ["### DiffCI: what this change affects", ""];
  const result = report.result;

  if (report.status !== "OBSERVED" || !result) {
    lines.push(`**No plan for this change** (${report.status.toLowerCase()} at ${report.stage}).`);
    if (report.reason) lines.push("", report.reason);
  } else if (result.mode === "FULL") {
    lines.push(
      `**The full test suite is needed** for ${plural(result.changedFileCount, "changed file")}: DiffCI could not prove which of the ${plural(result.totalTestCount, "test file")} this change leaves untouched, so it would run them all.`,
    );
    if (result.fallbackReasons.length > 0) {
      lines.push("", "Why:");
      for (const reason of result.fallbackReasons) lines.push(`- ${reason}`);
    }
  } else {
    const selected = result.selectedTests.length;
    lines.push(
      `**${selected} of ${plural(result.totalTestCount, "test file")}** ${selected === 1 ? "is" : "are"} affected by ${plural(result.changedFileCount, "changed file")}.`,
    );
    const baseline = result.pathBaseline.mode === "FULL"
      ? "everything"
      : plural(result.pathBaseline.selectedTestCount, "test file");
    lines.push(`A simple path-rule CI would have run ${baseline}.`);
    if (selected > 0) {
      const reasons = result.selectionReasons ?? {};
      lines.push("", `<details><summary>Why these ${plural(selected, "test")}</summary>`, "");
      lines.push("| Test | Because |", "| --- | --- |");
      for (const test of result.selectedTests.slice(0, MAX_LISTED_TESTS)) {
        const why = reasons[test];
        const because = why
          ? `${readableReason(why.reason)}${why.changed_file ? ` from ${code(why.changed_file)}` : ""}`
          : "affected by the change";
        lines.push(`| ${code(test)} | ${because} |`);
      }
      if (selected > MAX_LISTED_TESTS) lines.push(`| and ${selected - MAX_LISTED_TESTS} more | see the report artifact |`);
      lines.push("", "</details>");
    }
    if (result.proposedCommands.length > 0) {
      lines.push("", "Would run:", "");
      for (const command of result.proposedCommands) lines.push("```", command, "```");
    } else if (result.commandRefusalReason) {
      lines.push("", `No runnable command: ${result.commandRefusalReason}`);
    }
  }

  // A broken promise of non-interference is the one thing that must never hide in a collapsed block.
  const blocking = report.nonInterference.workflowFindings.filter((finding) => finding.severity === "BLOCKING");
  if (!report.nonInterference.worktreeUnchanged) {
    lines.push("", "> [!WARNING]", "> The working tree changed while DiffCI observed it. Please report this at https://github.com/DiffCI/core/issues.");
  }
  if (blocking.length > 0) {
    lines.push("", "> [!WARNING]", `> ${plural(blocking.length, "blocking workflow finding")}: this installation can affect other jobs. Details are in the full report below.`);
  }
  if (delivery?.startsWith("not sent")) lines.push("", `Delivery: ${delivery}`);

  lines.push(
    "",
    "<details><summary>Full report</summary>",
    "",
    "```",
    `${textSummary}${delivery ? `\n  delivery: ${delivery}` : ""}`,
    "```",
    "",
    "</details>",
    "",
    "<sub>Observation only: DiffCI ran, skipped and changed nothing in this workflow. [DiffCI](https://github.com/DiffCI/core) is open source (MIT) and tells AI coding agents what their change breaks.</sub>",
    "",
  );
  return lines.join("\n");
}
