// SPDX-License-Identifier: MIT

export interface ProvenanceSubject { name: string; digest?: { sha512?: string } }
export interface ProvenanceStatement { subject?: ProvenanceSubject[] }

/** Picks npm's SLSA v1 provenance bundle and decodes its in-toto statement; throws when there is none. */
export function slsaProvenance(attestations: unknown): { bundle: unknown; statement: ProvenanceStatement };

/** Returns the tarball's sha512 hex; throws unless it is the statement's only subject for this version. */
export function assertSubject(statement: ProvenanceStatement, version: string, tarball: Buffer): string;
