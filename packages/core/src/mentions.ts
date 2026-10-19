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

/**
 * Every handle that addresses a participant (PROTOCOL §5.5): its name, role and short id, and for an agent its owner
 * ("@mukhammad" reaches Mukhammad's agents) and owner plus role or client ("@islomov-backend", "@islomov-codex").
 */
export function handlesFor(participantId: string, profile?: Pick<Profile, "name" | "role" | "owner" | "client" | "kind">): string[] {
  const handles = new Set<string>(BROADCAST_HANDLES);
  handles.add(shortId(participantId).toLowerCase());
  if (profile?.name) handles.add(slug(profile.name));
  if (profile?.role) handles.add(slug(profile.role));
  const owner = profile?.kind !== "human" && profile?.owner ? slug(profile.owner) : "";
  if (owner) {
    handles.add(owner);
    if (profile?.role) handles.add(`${owner}-${slug(profile.role)}`);
    if (profile?.client && profile.client !== "cli") handles.add(`${owner}-${slug(profile.client.replace(/-code$/, ""))}`);
  }
  handles.delete("");
  return [...handles];
}

/** Normalizes an assignee such as "@Unity", "unity" or a participant id prefix to a handle. */
export const normalizeHandle = (value: string): string => slug(value.replace(/^@/, ""));
