import { shortId } from "./identity.js";
import type { Profile } from "./events.js";

const MENTION = /(^|[^A-Za-z0-9_.-])@([A-Za-z0-9_][A-Za-z0-9_.-]*)/g;

export const slug = (text: string): string =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Lowercased mention tokens (without `@`), trailing dots trimmed, unique, in order. */
export function extractMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const token = m[2].replace(/[.]+$/, "").toLowerCase();
    if (token && !out.includes(token)) out.push(token);
  }
  return out;
}

export const BROADCAST_HANDLES = ["all", "everyone", "here"];

/** Every handle that addresses a participant (PROTOCOL §5.5). */
export function handlesFor(participantId: string, profile?: Pick<Profile, "name" | "role">): string[] {
  const handles = new Set<string>(BROADCAST_HANDLES);
  handles.add(shortId(participantId).toLowerCase());
  if (profile?.name) handles.add(slug(profile.name));
  if (profile?.role) handles.add(slug(profile.role));
  handles.delete("");
  return [...handles];
}

/** Normalizes an assignee such as "@Unity", "unity" or a participant id prefix to a handle. */
export const normalizeHandle = (value: string): string => slug(value.replace(/^@/, ""));
