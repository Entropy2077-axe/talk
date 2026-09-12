import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams } from "react-router-dom";
import { TopBar } from "../components/TopBar";
import { ToggleSwitch } from "../components/ToggleSwitch";
import {
  MemoryEditor,
  MoodEditor,
  RelationEditor,
  ScheduleEditors,
  SocialEventEditor,
  TransactionEditor,
  WalletEditor,
  WorldbookBindingEditor,
} from "../components/ContactAdminStructuredEditors";
import { db } from "../db/db";
import {
  PROMPT_MODULE_DEFINITIONS,
  normalizePromptModules,
  unknownPromptPlaceholders,
} from "../lib/promptModules";
import {
  clonePromptModules,
  promptModulesForContact,
} from "../lib/promptPresets";
import {
  suggestContactAdminEdit,
  type ContactAdminSuggestion,
} from "../lib/contactAdminAssistant";
import { useSettingsStore } from "../store/useSettingsStore";
import type {
  Contact,
  ContactMemory,
  ContactRelationLink,
  LocationNode,
  PromptModuleId,
  PromptModuleSettings,
  ScheduleBlock,
  ScheduleOverride,
  SocialEvent,
  WalletAccount,
  WalletTransaction,
  WorldbookEntry,
} from "../types";
import { regenerateContactVisualIdentity } from "../lib/imageAssets";

const CONTACT_RUNTIME_MODULES = new Set<PromptModuleId>([
  "chat",
  "relationship",
  "memory",
  "worldview",
]);
const EMPTY_MEMORIES: ContactMemory[] = [];
const EMPTY_RELATIONS: ContactRelationLink[] = [];
const EMPTY_SOCIAL_EVENTS: SocialEvent[] = [];
const EMPTY_TRANSACTIONS: WalletTransaction[] = [];
const EMPTY_CONTACTS: Contact[] = [];
const EMPTY_LOCATIONS: LocationNode[] = [];
const EMPTY_WORLD_ENTRIES: WorldbookEntry[] = [];

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-gray-500">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
      />
    </label>
  );
}

function Area({
  label,
  value,
  onChange,
  rows = 5,
  mono = false,
  note,
  autoGrow = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  mono?: boolean;
  note?: string;
  autoGrow?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (!autoGrow || !textareaRef.current) return;
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
  }, [autoGrow, value]);
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-gray-500">{label}</span>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => {
          if (autoGrow) {
            event.currentTarget.style.height = "auto";
            event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`;
          }
          onChange(event.target.value);
        }}
        rows={rows}
        className={`w-full rounded-lg border border-gray-200 px-3 py-2 text-xs leading-relaxed ${autoGrow ? "resize-none overflow-hidden" : "resize-y"} ${mono ? "font-mono" : ""}`}
      />
      {note && (
        <span className="mt-1 block text-[10px] leading-relaxed text-gray-400">
          {note}
        </span>
      )}
    </label>
  );
}

export function ContactAdminPage() {
  const { contactId } = useParams();
  const settings = useSettingsStore();
  const contact = useLiveQuery(
    () => (contactId ? db.contacts.get(contactId) : undefined),
    [contactId],
  );
  const memories =
    useLiveQuery(
      () =>
        contactId
          ? db.contactMemories.where("contactId").equals(contactId).toArray()
          : EMPTY_MEMORIES,
      [contactId],
    ) ?? EMPTY_MEMORIES;
  const relations =
    useLiveQuery(
      () =>
        contactId
          ? db.contactRelations
              .filter(
                (row) =>
                  row.fromContactId === contactId ||
                  row.toContactId === contactId,
              )
              .toArray()
          : EMPTY_RELATIONS,
      [contactId],
    ) ?? EMPTY_RELATIONS;
  const socialEvents =
    useLiveQuery(
      async () =>
        contactId
          ? (await db.socialEvents.toArray()).filter(
              (row) =>
                row.actorId === contactId ||
                row.targetId === contactId ||
                row.relatedContactIds.includes(contactId),
            )
          : EMPTY_SOCIAL_EVENTS,
      [contactId],
    ) ?? EMPTY_SOCIAL_EVENTS;
  const wallet = useLiveQuery(
    () => (contactId ? db.walletAccounts.get(contactId) : undefined),
    [contactId],
  );
  const transactions =
    useLiveQuery(
      () =>
        contactId
          ? db.walletTransactions
              .filter(
                (row) =>
                  row.fromOwnerId === contactId || row.toOwnerId === contactId,
              )
              .toArray()
          : EMPTY_TRANSACTIONS,
      [contactId],
    ) ?? EMPTY_TRANSACTIONS;
  const allContacts = useLiveQuery(() => db.contacts.toArray(), []) ?? EMPTY_CONTACTS;
  const locations = useLiveQuery(() => db.locations.toArray(), []) ?? EMPTY_LOCATIONS;
  const worldbookEntries = useLiveQuery(() => db.worldbookEntries.toArray(), []) ?? EMPTY_WORLD_ENTRIES;

  const [draft, setDraft] = useState<Contact | null>(null);
  const [promptDraft, setPromptDraft] = useState<PromptModuleSettings | null>(
    null,
  );
  const [moodDraft, setMoodDraft] = useState<Contact["mood"]>();
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleBlock[]>([]);
  const [scheduleOverrideDraft, setScheduleOverrideDraft] = useState<ScheduleOverride[]>([]);
  const [memoryDraft, setMemoryDraft] = useState<ContactMemory[]>([]);
  const [relationDraft, setRelationDraft] = useState<ContactRelationLink[]>([]);
  const [socialDraft, setSocialDraft] = useState<SocialEvent[]>([]);
  const [walletDraft, setWalletDraft] = useState<WalletAccount | null>(null);
  const [transactionDraft, setTransactionDraft] = useState<WalletTransaction[]>([]);
  const [status, setStatus] = useState("");
  const [aiInstruction, setAiInstruction] = useState("");
  const [visualInstruction, setVisualInstruction] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [suggestion, setSuggestion] = useState<ContactAdminSuggestion | null>(
    null,
  );
  const [initializedId, setInitializedId] = useState("");

  useEffect(() => {
    if (!contact || initializedId === contact.id) return;
    setDraft(structuredClone(contact));
    setPromptDraft(
      clonePromptModules(promptModulesForContact(contact, settings)),
    );
    setMoodDraft(contact.mood ? structuredClone(contact.mood) : undefined);
    setScheduleDraft(structuredClone(contact.schedule ?? []));
    setScheduleOverrideDraft(structuredClone(contact.scheduleOverrides ?? []));
    setInitializedId(contact.id);
  }, [contact, initializedId, settings]);
  useEffect(() => {
    if (contact && initializedId === contact.id)
      setMemoryDraft(structuredClone(memories));
  }, [contact, initializedId, memories]);
  useEffect(() => {
    if (contact && initializedId === contact.id)
      setRelationDraft(structuredClone(relations));
  }, [contact, initializedId, relations]);
  useEffect(() => {
    if (contact && initializedId === contact.id)
      setSocialDraft(structuredClone(socialEvents));
  }, [contact, initializedId, socialEvents]);
  useEffect(() => {
    if (contact && initializedId === contact.id) setWalletDraft(wallet ? structuredClone(wallet) : null);
  }, [contact, initializedId, wallet]);
  useEffect(() => {
    if (contact && initializedId === contact.id)
      setTransactionDraft(structuredClone(transactions));
  }, [contact, initializedId, transactions]);

  const definitions = useMemo(
    () =>
      PROMPT_MODULE_DEFINITIONS.filter((definition) =>
        CONTACT_RUNTIME_MODULES.has(definition.id),
      ),
    [],
  );
  const patchDraft = (patch: Partial<Contact>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  function validatePromptModules(modules: PromptModuleSettings) {
    for (const definition of definitions)
      for (const template of definition.templates) {
        const unknown = unknownPromptPlaceholders(
          definition.id,
          template.id,
          modules[definition.id]?.templates?.[template.id] ?? "",
        );
        if (unknown.length)
          throw new Error(
            `${definition.name}／${template.name}含未知占位符：${unknown.join("、")}`,
          );
      }
  }

  async function saveAll() {
    if (!contactId || !contact || !draft || !promptDraft) return;
    setStatus("");
    try {
      const nickname = (draft.nickname?.trim() || draft.name.trim());
      if (!nickname) throw new Error("网名不能为空");
      const normalizedPromptDraft = normalizePromptModules(promptDraft);
      validatePromptModules(normalizedPromptDraft);
      const nextMemories = memoryDraft.map((row) => ({ ...row, contactId }));
      const nextRelations = relationDraft;
      const nextSocial = socialDraft;
      const nextWallet = walletDraft;
      const nextTransactions = transactionDraft;
      if (moodDraft && (!moodDraft.text.trim() || !Number.isFinite(moodDraft.expiresAt))) throw new Error("请完整填写当前心情");
      if (scheduleDraft.some((item) => !item.activity.trim() || !Number.isInteger(item.startHour) || !Number.isInteger(item.endHour) || item.startHour === item.endHour)) throw new Error("请检查固定日程的活动和时间");
      if (scheduleOverrideDraft.some((item) => !item.date || !item.activity.trim() || !item.summary.trim() || item.startHour === item.endHour)) throw new Error("请检查特殊日程的日期、内容和时间");
      if (nextMemories.some((item) => !item.content.trim())) throw new Error("记忆内容不能为空");
      if (nextRelations.some((item) => !item.fromContactId || !item.toContactId || !item.label.trim())) throw new Error("请完整填写 AI 关系");
      if (nextSocial.some((item) => !item.summary.trim() || !Number.isFinite(item.createdAt))) throw new Error("请完整填写社交动态");
      if (nextWallet && !Number.isFinite(nextWallet.balance)) throw new Error("钱包余额必须是有效数字");
      if (nextTransactions.some((item) => !Number.isFinite(item.amount) || item.amount < 0 || !Number.isFinite(item.createdAt))) throw new Error("请检查交易金额和时间");

      await db.transaction(
        "rw",
        [
          db.contacts,
          db.contactMemories,
          db.contactRelations,
          db.socialEvents,
          db.walletAccounts,
          db.walletTransactions,
        ],
        async () => {
          await db.contacts.put({
            ...draft,
            // `name` remains the legacy required field, but must never drift
            // from the nickname that the UI uses as the displayed name.
            name: nickname,
            nickname,
            id: contact.id,
            createdAt: contact.createdAt,
            mood: moodDraft,
            schedule: scheduleDraft,
            scheduleOverrides: scheduleOverrideDraft,
            promptModulesSnapshot: clonePromptModules(normalizedPromptDraft),
            promptPresetSourceName: "联系人单独修改",
            promptSnapshotUpdatedAt: Date.now(),
          });
          await db.contactMemories
            .where("contactId")
            .equals(contactId)
            .delete();
          if (nextMemories.length)
            await db.contactMemories.bulkPut(nextMemories);
          await db.contactRelations
            .filter(
              (row) =>
                row.fromContactId === contactId ||
                row.toContactId === contactId,
            )
            .delete();
          if (nextRelations.length)
            await db.contactRelations.bulkPut(nextRelations);
          await db.socialEvents
            .filter(
              (row) =>
                row.actorId === contactId ||
                row.targetId === contactId ||
                row.relatedContactIds.includes(contactId),
            )
            .delete();
          if (nextSocial.length) await db.socialEvents.bulkPut(nextSocial);
          if (nextWallet)
            await db.walletAccounts.put({ ...nextWallet, ownerId: contactId });
          else await db.walletAccounts.delete(contactId);
          await db.walletTransactions
            .filter(
              (row) =>
                row.fromOwnerId === contactId || row.toOwnerId === contactId,
            )
            .delete();
          if (nextTransactions.length)
            await db.walletTransactions.bulkPut(nextTransactions);
        },
      );
      setStatus("已保存，下一轮聊天会使用新资料。");
      setDraft((current) =>
        current
          ? {
              ...current,
              promptModulesSnapshot: clonePromptModules(normalizedPromptDraft),
              promptSnapshotUpdatedAt: Date.now(),
            }
          : current,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function askAi() {
    if (!contact || !draft || !promptDraft || !aiInstruction.trim()) return;
    if (!settings.apiKey) {
      setStatus("请先配置 API Key");
      return;
    }
    setAiBusy(true);
    setStatus("");
    setSuggestion(null);
    try {
      const result = await suggestContactAdminEdit({
        settings,
        contact: draft,
        promptModules: promptDraft,
        instruction: aiInstruction.trim(),
      });
      setSuggestion(result);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setAiBusy(false);
    }
  }

  function applySuggestion() {
    if (!suggestion || !draft || !promptDraft) return;
    const unsafe = suggestion.contactPatch ?? {};
    const {
      id: _id,
      createdAt: _createdAt,
      personaConstraints: _personaConstraints,
      personaProfile: _personaProfile,
      personalityTrait: _personalityTrait,
      customPersonalityTraits: _customPersonalityTraits,
      speechSamples: _speechSamples,
      mbti: _mbti,
      sharedHistory: _sharedHistory,
      ...safePatch
    } = unsafe;
    void _id;
    void _createdAt;
    void _personaConstraints;
    void _personaProfile;
    void _personalityTrait;
    void _customPersonalityTraits;
    void _speechSamples;
    void _mbti;
    void _sharedHistory;
    setDraft({
      ...draft,
      ...safePatch,
      id: draft.id,
      createdAt: draft.createdAt,
    });
    if ("mood" in safePatch) setMoodDraft(safePatch.mood ? structuredClone(safePatch.mood) : undefined);
    if ("schedule" in safePatch)
      setScheduleDraft(structuredClone(safePatch.schedule ?? []));
    if ("scheduleOverrides" in safePatch)
      setScheduleOverrideDraft(structuredClone(safePatch.scheduleOverrides ?? []));
    if (suggestion.promptModulePatches) {
      const next = clonePromptModules(promptDraft);
      for (const [moduleId, patch] of Object.entries(
        suggestion.promptModulePatches,
      )) {
        if (!patch || !next[moduleId as PromptModuleId]) continue;
        next[moduleId as PromptModuleId] = {
          ...next[moduleId as PromptModuleId],
          ...patch,
          templates: {
            ...next[moduleId as PromptModuleId].templates,
            ...(patch.templates ?? {}),
          },
        };
      }
      setPromptDraft(normalizePromptModules(next));
    }
    setSuggestion(null);
    setStatus("AI 方案已载入编辑区，尚未保存到后台。");
  }

  if (!settings.adminModeEnabled)
    return (
      <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[var(--ui-bg)]">
        <TopBar title="管理员编辑" showBack />
        <p className="p-8 text-center text-sm text-[var(--ui-text-3)]">
          请先开启管理员模式
        </p>
      </div>
    );
  if (!contact || !draft || !promptDraft) return null;

  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[var(--ui-bg)]">
      <TopBar title="编辑全部资料" showBack />
      <div className="flex-1 space-y-3 overflow-y-auto px-3 pb-28 pt-3 [&>section]:!mt-0 [&>section]:rounded-[var(--ui-radius-card)] [&>section]:shadow-[var(--ui-shadow)]">
        <section className="bg-[var(--ui-surface)] px-4 py-4">
          <p className="text-xs font-medium text-[var(--ui-text-3)]">
            当前编辑对象
          </p>
          <h1 className="ui-font-display mt-1 text-lg font-semibold text-[var(--ui-text)]">
            {draft.remark || draft.name}
          </h1>
          <p className="mt-2 text-xs leading-relaxed text-[var(--ui-text-3)]">
            先处理人物和关系资料；提示词、协议与真实后台数据属于低频高级内容，修改后统一在底部保存。
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[11px]">
            <span className="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] px-2 py-2 text-[var(--ui-text-2)]">
              身份与人设
            </span>
            <span className="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] px-2 py-2 text-[var(--ui-text-2)]">
              关系与生活
            </span>
            <span className="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] px-2 py-2 text-[var(--ui-text-2)]">
              高级数据
            </span>
          </div>
        </section>
        <section className="mt-3 bg-white px-4 py-4">
          <h2 className="text-sm font-medium text-gray-900">AI 协助二次编辑</h2>
          <p className="mt-1 text-[11px] text-gray-400">
            AI 只生成差异方案；载入后仍需你点击底部保存。
          </p>
          <Area
            label="你希望怎么修改"
            value={aiInstruction}
            onChange={setAiInstruction}
            rows={3}
          />
          <button
            type="button"
            onClick={() => void askAi()}
            disabled={aiBusy || !aiInstruction.trim()}
            className="mt-2 w-full rounded-lg bg-[var(--ui-special)] py-2.5 text-sm text-white disabled:opacity-40"
          >
            {aiBusy ? "正在整理修改方案…" : "生成修改方案"}
          </button>
          {suggestion && (
            <div className="mt-3 rounded-xl border border-[var(--ui-special-border)] bg-[var(--ui-special-soft)] p-3">
              <p className="text-sm font-medium text-[var(--ui-special-ink)]">
                {suggestion.summary}
              </p>
              <p className="mt-2 text-[11px] leading-5 text-gray-600">
                {Object.keys(suggestion.contactPatch ?? {}).length > 0
                  ? `人物资料：${Object.keys(suggestion.contactPatch ?? {}).join("、")}`
                  : "人物资料：无修改"}
                <br />
                {Object.keys(suggestion.promptModulePatches ?? {}).length > 0
                  ? `提示词模块：${Object.keys(suggestion.promptModulePatches ?? {}).join("、")}`
                  : "提示词模块：无修改"}
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => setSuggestion(null)}
                  className="flex-1 rounded-lg bg-white py-2 text-xs text-gray-600"
                >
                  放弃
                </button>
                <button
                  onClick={applySuggestion}
                  className="flex-1 rounded-lg bg-gray-900 py-2 text-xs text-white"
                >
                  载入编辑区
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="mt-3 space-y-3 bg-white px-4 py-4">
          <h2 className="text-sm font-medium text-gray-900">身份与人设</h2>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="备注"
              value={draft.remark ?? ""}
              onChange={(value) => patchDraft({ remark: value })}
            />
            <Field
              label="真名"
              value={draft.realName ?? ""}
              onChange={(value) => patchDraft({ realName: value })}
            />
            <Field
              label="网名/昵称（显示名称）"
              value={draft.nickname ?? draft.name}
              onChange={(value) => patchDraft({ nickname: value, name: value })}
            />
            <Field
              label="性别"
              value={draft.gender ?? ""}
              onChange={(value) => patchDraft({ gender: value })}
            />
            <Field
              label="生日"
              value={draft.birthday ?? ""}
              onChange={(value) => patchDraft({ birthday: value })}
            />
            <Field
              label="关系定位"
              value={draft.relationshipBase}
              onChange={(value) => patchDraft({ relationshipBase: value })}
            />
            <Field
              label="好感度 -100~100"
              type="number"
              value={draft.warmth ?? 0}
              onChange={(value) =>
                patchDraft({
                  warmth: Math.max(-100, Math.min(100, Number(value))),
                })
              }
            />
            <Field
              label="职业"
              value={draft.occupation ?? ""}
              onChange={(value) => patchDraft({ occupation: value })}
            />
            <Field
              label="月薪"
              type="number"
              value={draft.monthlySalary ?? 0}
              onChange={(value) => patchDraft({ monthlySalary: Number(value) })}
            />
          </div>
          <Area
            label="人设"
            value={draft.systemPrompt}
            onChange={(value) => patchDraft({ systemPrompt: value })}
            rows={16}
            autoGrow
            note="身份背景、性格表现、边界、习惯、行为方式和说话方式全部集中在这里。"
          />
          <Area
            label="标准长相"
            value={draft.visualIdentity ?? ""}
            onChange={(value) => patchDraft({ visualIdentity: value })}
            rows={4}
            note="稳定外貌描述；不要包含临时服装、动作、背景或画风。"
          />
          <Area
            label="这次希望 AI 怎么修改外貌"
            value={visualInstruction}
            onChange={setVisualInstruction}
            rows={3}
            note="例如：改成齐肩黑发、灰蓝色眼睛，保留原来的脸型和身材。每次生成都以这里的要求为准。"
          />
          <button
            type="button"
            disabled={aiBusy || !settings.apiKey || !visualInstruction.trim()}
            onClick={async () => {
              if (
                draft.visualIdentity &&
                !window.confirm("重新生成会覆盖当前标准长相，确定继续？")
              )
                return;
              setAiBusy(true);
              try {
                const value = await regenerateContactVisualIdentity(
                  draft,
                  settings,
                  visualInstruction,
                );
                patchDraft({ visualIdentity: value });
                setVisualInstruction("");
                setStatus("已生成新的标准长相，请保存全部修改。");
              } catch (error) {
                setStatus(
                  error instanceof Error ? error.message : String(error),
                );
              } finally {
                setAiBusy(false);
              }
            }}
            className="w-full rounded-lg bg-gray-100 py-2 text-xs text-gray-600 disabled:opacity-40"
          >
            {aiBusy ? "正在生成外貌描述…" : "按要求重新生成外貌描述"}
          </button>
        </section>

        <section className="mt-3 space-y-3 bg-white px-4 py-4">
          <h2 className="text-sm font-medium text-gray-900">
            关系、状态与生活
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs text-gray-500">当前位置</span>
              <select value={draft.currentLocationId ?? ""} onChange={(event) => patchDraft({ currentLocationId: event.target.value || undefined, locationSource: 'manual', locationUpdatedAt: Date.now() })} className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm">
                <option value="">未指定</option>
                {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
              </select>
            </label>
            <Field
              label="当前活动"
              value={draft.currentActivity ?? ""}
              onChange={(value) => patchDraft({ currentActivity: value })}
            />
          </div>
          <Area
            label="关系动态"
            value={draft.relationshipDynamic}
            onChange={(value) => patchDraft({ relationshipDynamic: value })}
          />
          <div><h3 className="mb-2 text-xs font-medium text-gray-700">当前心情</h3><MoodEditor value={moodDraft} onChange={setMoodDraft} /></div>
          <ScheduleEditors schedule={scheduleDraft} onScheduleChange={setScheduleDraft} overrides={scheduleOverrideDraft} onOverridesChange={setScheduleOverrideDraft} locations={locations} />
          <div><h3 className="mb-2 text-xs font-medium text-gray-700">绑定世界书条目</h3><WorldbookBindingEditor entries={worldbookEntries} selectedIds={draft.worldbookEntryIds ?? []} onChange={(worldbookEntryIds) => patchDraft({ worldbookEntryIds })} /></div>
        </section>

        <section className="mt-3 bg-white px-4 py-4">
          <h2 className="text-sm font-medium text-gray-900">
            当前联系人固定提示词
          </h2>
          <p className="mt-1 text-[11px] text-gray-400">
            这里只修改当前联系人，不会反向修改全局存档。
          </p>
          <div className="mt-3 space-y-3">
            {definitions.map((definition) => {
              const config = promptDraft[definition.id];
              if (!config) return null;
              return (
                <details
                  key={definition.id}
                  className="rounded-xl border border-gray-200 p-3"
                >
                  <summary className="flex cursor-pointer list-none items-center gap-3">
                    <span className="min-w-0 flex-1 text-sm font-medium text-gray-800">
                      {definition.name}
                    </span>
                    <ToggleSwitch
                      checked={config.enabled}
                      onChange={(enabled) =>
                        setPromptDraft((current) =>
                          current
                            ? {
                                ...current,
                                [definition.id]: {
                                  ...current[definition.id],
                                  enabled,
                                },
                              }
                            : current,
                        )
                      }
                      ariaLabel={`切换${definition.name}`}
                    />
                  </summary>
                  <div className="mt-3 space-y-3">
                    {definition.templates.map((template) => (
                      <Area
                        key={template.id}
                        label={template.name}
                        value={config.templates[template.id] ?? ""}
                        onChange={(value) =>
                          setPromptDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  [definition.id]: {
                                    ...current[definition.id],
                                    templates: {
                                      ...current[definition.id].templates,
                                      [template.id]: value,
                                    },
                                  },
                                }
                              : current,
                          )
                        }
                        rows={8}
                        mono
                        note={
                          template.placeholders.length
                            ? `可用占位符：${template.placeholders.map((key) => `{{${key}}}`).join("、")}`
                            : undefined
                        }
                      />
                    ))}
                  </div>
                </details>
              );
            })}
          </div>
        </section>

        <section className="mt-3 space-y-4 bg-white px-4 py-4">
          <h2 className="text-sm font-medium text-gray-900">记忆与社交数据</h2>
          <p className="text-[11px] leading-relaxed text-amber-600">
            这些内容会影响 AI 对过去、关系和近期事件的判断。每项均可展开编辑，不需要接触 JSON。
          </p>
          <MemoryEditor value={memoryDraft} onChange={setMemoryDraft} contactId={contact.id} contacts={allContacts} />
          <RelationEditor value={relationDraft} onChange={setRelationDraft} contactId={contact.id} contacts={allContacts} />
          <SocialEventEditor value={socialDraft} onChange={setSocialDraft} contactId={contact.id} contacts={allContacts} />
        </section>

        <section className="mt-3 space-y-4 bg-white px-4 py-4">
          <h2 className="text-sm font-medium text-gray-900">钱包与交易</h2>
          <WalletEditor value={walletDraft} onChange={setWalletDraft} contactId={contact.id} />
          <TransactionEditor value={transactionDraft} onChange={setTransactionDraft} contactId={contact.id} contacts={allContacts} />
        </section>
      </div>
      <div className="absolute inset-x-0 bottom-0 border-t border-[var(--ui-border)] bg-[var(--ui-surface)] px-4 py-3 pb-[calc(.75rem+env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={() => void saveAll()}
          className="w-full rounded-[var(--ui-radius-control)] bg-[var(--ui-action)] py-3 text-sm font-medium text-[var(--ui-on-action)]"
        >
          保存全部修改
        </button>
        {status && (
          <p
            className={`mt-2 text-center text-xs ${status.startsWith("已") || status.includes("载入") ? "text-[var(--ui-success-ink)]" : "text-[var(--ui-danger-ink)]"}`}
          >
            {status}
          </p>
        )}
      </div>
    </div>
  );
}
