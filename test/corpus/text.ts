// Neutral English work text and short samples in other scripts, for the
// corpus's Markdown files. Nothing here names a real person, company or tool.

import type { Rng } from "./rng.ts";

const NOUNS = [
  "release", "rollout", "service", "dashboard", "migration", "schedule", "budget", "review", "backlog",
  "incident", "runbook", "checklist", "milestone", "workshop", "survey", "proposal", "roadmap", "pipeline",
  "dataset", "report", "template", "integration", "deployment", "handover", "retrospective", "estimate",
  "dependency", "queue", "cache", "index", "storage", "network", "alert", "metric", "contract", "invoice",
];
const VERBS = [
  "review", "update", "confirm", "draft", "schedule", "measure", "compare", "archive", "approve", "publish",
  "test", "simplify", "document", "share", "plan", "track", "merge", "split", "rename", "monitor",
];
const ADJECTIVES = [
  "quarterly", "weekly", "shared", "internal", "public", "updated", "draft", "final", "pending", "stable",
  "regional", "manual", "automated", "optional", "critical", "minor", "new", "legacy", "temporary", "default",
];
const TEAMS = ["platform", "mobile", "data", "support", "design", "finance", "operations", "research", "security", "web"];
const PEOPLE = ["Alex", "Sam", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Avery", "Quinn", "Robin", "Drew"];

export const SCRIPT_SAMPLES: Record<string, string[]> = {
  greek: ["Η συνάντηση είναι αύριο το πρωί.", "Ενημερώστε τον πίνακα έργων.", "Καλή συνέχεια σε όλους."],
  chinese: ["会议记录已经更新。", "请在周五之前完成审核。", "项目计划需要再讨论。"],
  japanese: ["会議は明日の朝です。", "資料を共有してください。", "進捗を確認しました。"],
  korean: ["회의는 내일 아침입니다.", "문서를 검토해 주세요.", "일정이 변경되었습니다."],
  arabic: ["الاجتماع غدا في الصباح.", "يرجى مراجعة الخطة.", "تم تحديث الجدول."],
  hebrew: ["הפגישה מחר בבוקר.", "נא לעדכן את המסמך.", "התוכנית אושרה."],
  devanagari: ["बैठक कल सुबह है।", "कृपया योजना की समीक्षा करें।", "सूची अपडेट हो गई है।"],
  thai: ["การประชุมพรุ่งนี้เช้า", "กรุณาตรวจสอบเอกสาร", "แผนงานได้รับการอนุมัติแล้ว"],
};

export const EMOJI = ["✅", "🚀", "📌", "🔧", "📈", "🗓️", "💡", "⚠️", "🎯", "📝"];
export const EMOJI_SEQUENCES = ["👩‍💻", "👨‍👩‍👧", "🧑🏽‍🔬", "👍🏽", "👋🏿", "🏳️‍🌈", "🇯🇵", "🇧🇷", "❤️‍🔥", "🧑‍🤝‍🧑"];

export function word(rng: Rng): string {
  return rng.pick(NOUNS);
}

export function person(rng: Rng): string {
  return rng.pick(PEOPLE);
}

export function team(rng: Rng): string {
  return rng.pick(TEAMS);
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function sentence(rng: Rng): string {
  const forms = [
    () => `${capitalize(rng.pick(VERBS))} the ${rng.pick(ADJECTIVES)} ${rng.pick(NOUNS)} before the ${rng.pick(NOUNS)}.`,
    () => `The ${rng.pick(TEAMS)} team will ${rng.pick(VERBS)} the ${rng.pick(NOUNS)} this week.`,
    () => `${rng.pick(PEOPLE)} owns the ${rng.pick(ADJECTIVES)} ${rng.pick(NOUNS)} and will ${rng.pick(VERBS)} it.`,
    () => `We agreed to ${rng.pick(VERBS)} the ${rng.pick(NOUNS)} after the ${rng.pick(ADJECTIVES)} ${rng.pick(NOUNS)}.`,
    () => `Open question: should the ${rng.pick(NOUNS)} stay ${rng.pick(ADJECTIVES)}?`,
  ];
  return rng.pick(forms)();
}

export function paragraph(rng: Rng, sentences = rng.int(2, 5)): string {
  return Array.from({ length: sentences }, () => sentence(rng)).join(" ");
}

export function title(rng: Rng): string {
  return `${capitalize(rng.pick(ADJECTIVES))} ${rng.pick(NOUNS)} ${rng.pick(["plan", "notes", "summary", "update", "guide", "review"])}`;
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function isoDate(rng: Rng): string {
  return `2026-${String(rng.int(1, 12)).padStart(2, "0")}-${String(rng.int(1, 28)).padStart(2, "0")}`;
}

/** Plain ASCII filler of exactly the given length, in lines of prose. */
export function asciiFiller(rng: Rng, length: number): string {
  let out = "";
  while (out.length < length) out += `${paragraph(rng)}\n\n`;
  return out.slice(0, length);
}
