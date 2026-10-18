import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ChangeSpecification {
  id: string;
  logicalTarget: string | string[];
  description?: string;
}

export interface SpecificationConflict {
  logicalTarget: string;
  specificationIds: string[];
}

export interface SpecificationConflictReport {
  schema: "diffci.specConflicts.v1";
  valid: boolean;
  specificationsChecked: number;
  logicalTargetsChecked: number;
  conflicts: SpecificationConflict[];
  blockers: string[];
}

function normalizeTarget(target: string): string {
  return target.trim();
}

export function detectSpecificationConflicts(specifications: readonly ChangeSpecification[]): SpecificationConflictReport {
  const ids = new Set<string>();
  const owners = new Map<string, Set<string>>();
  for (const specification of specifications) {
    if (!specification || typeof specification.id !== "string" || !specification.id.trim()) throw new Error("every specification requires a non-empty id");
    const id = specification.id.trim();
    if (ids.has(id)) throw new Error(`duplicate specification id: ${id}`);
    ids.add(id);
    const rawTargets = Array.isArray(specification.logicalTarget) ? specification.logicalTarget : [specification.logicalTarget];
    if (!rawTargets.length || rawTargets.some((target) => typeof target !== "string" || !target.trim())) {
      throw new Error(`specification ${id} requires at least one non-empty logicalTarget`);
    }
    for (const rawTarget of rawTargets) {
      const target = normalizeTarget(rawTarget);
      const targetOwners = owners.get(target) ?? new Set<string>();
      targetOwners.add(id);
      owners.set(target, targetOwners);
    }
  }

  const conflicts = [...owners.entries()]
    .filter(([, targetOwners]) => targetOwners.size > 1)
    .map(([logicalTarget, targetOwners]) => ({ logicalTarget, specificationIds: [...targetOwners].sort() }))
    .sort((a, b) => a.logicalTarget.localeCompare(b.logicalTarget));
  return {
    schema: "diffci.specConflicts.v1",
    valid: conflicts.length === 0,
    specificationsChecked: specifications.length,
    logicalTargetsChecked: owners.size,
    conflicts,
    blockers: conflicts.map((conflict) => `logical target "${conflict.logicalTarget}" is changed by specifications ${conflict.specificationIds.join(", ")}`),
  };
}

export function readSpecificationFile(path: string): ChangeSpecification[] {
  const parsed = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  const specifications = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { specifications?: unknown }).specifications)
      ? (parsed as { specifications: unknown[] }).specifications
      : undefined;
  if (!specifications) throw new Error("specification file must be an array or an object with a specifications array");
  return specifications as ChangeSpecification[];
}

