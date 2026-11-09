// Short pieces of neutral English work text and samples in other scripts,
// for the corpus's Markdown files. Sentences come from the hand-written
// topics of the fictional company in company.ts.

import { PEOPLE, PROFILES } from "./company.ts";
import type { Rng } from "./rng.ts";

const NOUNS = [
  "release", "rollout", "service", "dashboard", "migration", "schedule", "budget", "review", "backlog",
  "incident", "runbook", "checklist", "milestone", "workshop", "survey", "proposal", "roadmap", "pipeline",
  "dataset", "report", "template", "integration", "deployment", "handover", "retrospective", "estimate",
  "dependency", "queue", "cache", "index", "storage", "network", "alert", "metric", "contract", "invoice",
  "route", "depot", "driver", "parcel", "stop", "planner",
];
const TEAMS = ["platform", "mobile", "data", "support", "design", "finance", "operations", "research", "security", "web"];

/** Every topic sentence of the company, ASCII only, so fillers stay plain ASCII. */
const SENTENCES: string[] = Object.values(PROFILES)
  .flatMap((p) => p.topics.flatMap((t) => [t.summary, t.problem, t.change, t.risk]))
  .filter((s) => /^[\x20-\x7e]+$/.test(s));
const TITLES: string[] = Object.values(PROFILES).flatMap((p) => p.topics.map((t) => t.title));

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

/** A first name. */
export function person(rng: Rng): string {
  return rng.pick(PEOPLE).split(" ")[0] as string;
}

export function team(rng: Rng): string {
  return rng.pick(TEAMS);
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function sentence(rng: Rng): string {
  return rng.pick(SENTENCES);
}

export function paragraph(rng: Rng, sentences = rng.int(2, 4)): string {
  return Array.from({ length: sentences }, () => sentence(rng)).join(" ");
}

export function title(rng: Rng): string {
  return rng.pick(TITLES);
}

export function isoDate(rng: Rng): string {
  return `2026-${String(rng.int(1, 12)).padStart(2, "0")}-${String(rng.int(1, 28)).padStart(2, "0")}`;
}

/** Plain ASCII filler of exactly the given length, in paragraphs of prose. */
export function asciiFiller(rng: Rng, length: number): string {
  let out = "";
  while (out.length < length) out += `${paragraph(rng)}\n\n`;
  return out.slice(0, length);
}
