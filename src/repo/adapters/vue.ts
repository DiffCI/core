import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { contribution, type RepositoryAdapter } from "./types.js";

/** Explicit Vue SFC imports. Runtime component registries and preprocessors require full CI. */
export const vueAdapter: RepositoryAdapter = {
  id: "vue", version: "1", kind: "framework",
  detect: ({ files }) => files.some((file) => file.endsWith(".vue")),
  analyze(context) {
    const result = contribution(this);
    const dependencies = [...context.profile.packageJson.dependencies, ...context.profile.packageJson.devDependencies];
    if (dependencies.includes("nuxt") || context.files.some((file) => /(?:^|\/)nuxt\.config\./.test(file))) {
      result.blockers.push("Nuxt implicit routes and auto-imports require a dedicated framework adapter");
    }
    for (const path of context.files.filter((file) => file.endsWith(".vue"))) {
      result.sourcePaths.push(path);
      const block = (reason: string) => result.blockers.push(`Vue ${path}: ${reason}`);
      try {
        const { descriptor, errors } = parse(readFileSync(join(context.repoPath, path), "utf8"), { filename: path });
        if (errors.length) block("component parse failed");
        if (descriptor.customBlocks.length) block("custom blocks require a framework plugin");
        const blocks = [descriptor.script, descriptor.scriptSetup, descriptor.template, ...descriptor.styles].filter((b) => b !== null);
        for (const b of blocks) {
          if (b.src) block("external SFC blocks are not yet modeled");
          if (b.lang && !["js", "ts", "jsx", "tsx", "html", "css"].includes(b.lang)) block(`unsupported preprocessor ${b.lang}`);
        }
        const script = descriptor.script || descriptor.scriptSetup
          ? compileScript(descriptor, { id: path }) : undefined;
        let source = script?.content ?? "";
        if (/\bimport\.meta\.glob(?:Eager)?\s*\(/.test(source)) block("glob imports require bundler dependency expansion");
        if (descriptor.template && !descriptor.template.src && !descriptor.template.lang) {
          const template = compileTemplate({
            source: descriptor.template.content, filename: path, id: path,
            compilerOptions: { bindingMetadata: script?.bindings },
          });
          if (template.errors.length) block("template compilation failed");
          // These calls represent dependencies supplied at runtime, outside the import graph.
          if (/\b_resolve(?:DynamicComponent|Component|Directive)\s*\(/.test(template.code)) block("runtime component/directive resolution requires full validation");
          source += `\n${template.code}`;
        } else if (descriptor.template) block("external or preprocessed template requires full validation");
        for (const style of descriptor.styles) {
          // CSS imports/URLs may be rewritten by arbitrary bundler plugins. Do not guess.
          if (/@import\b|url\s*\(/i.test(style.content)) block("style imports or URLs require full validation");
        }
        result.virtualSources.push({ path, source });
      } catch {
        block("component could not be analyzed");
      }
    }
    return result;
  },
};
