import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { v4 as uuid } from "uuid";
import { TopBar } from "../components/TopBar";
import { db } from "../db/db";
import { useSettingsStore } from "../store/useSettingsStore";
import { chatCompletionText as chatCompletion } from "../lib/deepseek";
import { buildJobsPrompt, parseJobs, employmentPatch } from "../lib/career";
import { USER_WALLET_ID } from "../lib/finance";
import { formatCurrency } from "../lib/wallet";
import { ToggleSwitch } from "../components/ToggleSwitch";

export function WorkPage() {
  const settings = useSettingsStore(),
    navigate = useNavigate();
  const [query, setQuery] = useState(""),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const jobs =
    useLiveQuery(
      () => db.jobListings.orderBy("createdAt").reverse().toArray(),
      [],
    ) ?? [];
  const activeInterview = useLiveQuery(
    () => db.interviews.where("status").equals("active").first(),
    [],
  );
  const activeJob = activeInterview
    ? jobs.find((job) => job.id === activeInterview.jobId)
    : undefined;
  const wallet = useLiveQuery(() => db.walletAccounts.get(USER_WALLET_ID), []);
  async function generate(search = query) {
    if (!settings.apiKey) {
      setError("请先在设置中配置 API Key");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const prompt = buildJobsPrompt(search.trim() || undefined, settings);
      if (!prompt.trim()) throw new Error("职业提示词模块已屏蔽");
      const raw = await chatCompletion({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.utilityModel,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: "生成岗位" },
        ],
        jsonMode: true,
      });
      const list = parseJobs(raw);
      if (!list.length) throw new Error("岗位生成失败，请重试");
      await db.jobListings.bulkAdd(
        list.map((j) => ({
          ...j,
          id: uuid(),
          status: "open" as const,
          sourceQuery: search.trim() || undefined,
          createdAt: Date.now(),
        })),
      );
      setPage(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  async function hire(job: (typeof jobs)[number]) {
    if (!confirm(`跳过面试，直接入职“${job.title}”？`)) return;
    const p = employmentPatch(job.title, job.monthlySalary);
    settings.setSettings({
      userOccupation: p.occupation,
      userMonthlySalary: p.monthlySalary,
      userJobStartedDate: p.jobStartedDate,
      userLastSalaryDate: p.lastSalaryDate,
    });
    await db.jobListings.update(job.id, { status: "hired", hiredBySkip: true });
  }
  return (
    <div className="ui-page">
      <TopBar
        title="工作"
        showBack
        right={
          <span className="pr-2 text-xs text-gray-500">
            {formatCurrency(wallet?.balance ?? 0, settings)}
          </span>
        }
      />
      <div className="ui-page-scroll">
        <header className="ui-page-intro">
          <p className="ui-page-kicker">当前职业</p>
          <h1 className="ui-page-title">
            {settings.userOccupation || "待业中"}
          </h1>
          <p className="ui-page-summary">
            {settings.userOccupation
              ? `月薪 ${formatCurrency(settings.userMonthlySalary, settings)}`
              : "搜索岗位，选择最适合自己的下一份工作。"}
          </p>
        </header>
        <section className="ui-section-card flex items-center justify-between px-4 py-3">
          <div>
            <p className="ui-list-label">宝宝模式</p>
            <p className="ui-list-note">
              开启后跳过专业面试，申请岗位即可直接入职
            </p>
          </div>
          <ToggleSwitch
            checked={settings.jobBabyMode}
            onChange={(checked) =>
              settings.setSettings({ jobBabyMode: checked })
            }
            ariaLabel="切换宝宝模式"
          />
        </section>
        {activeInterview && (
          <section className="ui-section-card ui-section-spaced px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-orange-500">
                  进行中的面试
                </p>
                <p className="mt-1 truncate text-sm font-medium text-gray-900">
                  {activeJob
                    ? `${activeJob.company} · ${activeJob.title}`
                    : "岗位面试"}
                </p>
                <p className="mt-0.5 text-[11px] text-gray-400">
                  已完成 {activeInterview.round}/4 轮，面试记录已保存
                </p>
              </div>
              <button
                onClick={() =>
                  navigate(`/work/interview/${activeInterview.jobId}`)
                }
                className="shrink-0 rounded-lg bg-orange-50 px-3 py-2 text-sm text-orange-600"
              >
                继续面试
              </button>
            </div>
          </section>
        )}
        <p className="ui-section-label">寻找岗位</p>
        <div className="mt-1 flex gap-2 px-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void generate();
            }}
            placeholder="搜索职位、行业或技能"
            className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
          />
          <button
            disabled={loading}
            onClick={() => void generate()}
            className="rounded-lg bg-gray-900 px-4 text-sm text-white disabled:opacity-40"
          >
            {loading ? "生成中" : "搜索"}
          </button>
        </div>
        <button
          onClick={() => {
            setQuery("");
            void generate("");
          }}
          className="mx-4 mt-2 text-xs text-gray-500"
        >
          随机生成岗位
        </button>
        {error && <p className="mx-4 mt-2 text-xs text-red-500">{error}</p>}
        <div className="mx-3 mt-3 space-y-3">
          {jobs.slice(page * 4, page * 4 + 4).map((job) => (
            <article key={job.id} className="rounded-[var(--ui-radius-card)] border border-[var(--ui-border)] bg-[var(--ui-surface)] p-4">
              <div className="flex justify-between gap-2">
                <div>
                  <h3 className="font-medium">{job.title}</h3>
                  <p className="text-xs text-gray-400">
                    {job.company} · {job.difficulty}
                  </p>
                </div>
                <b className="text-sm text-[var(--ui-special-ink)]">
                  {formatCurrency(job.monthlySalary, settings)}/月
                </b>
              </div>
              <p className="mt-2 text-sm text-gray-600">{job.description}</p>
              <p className="mt-2 text-xs text-gray-400">
                要求：{job.requirements.join("；") || "面试详谈"}
              </p>
              {job.status === "open" ? (
                <button
                  onClick={() =>
                    settings.jobBabyMode
                      ? void hire(job)
                      : navigate(`/work/interview/${job.id}`)
                  }
                  className={`mt-3 w-full rounded-lg py-2 text-sm ${settings.jobBabyMode ? "bg-green-50 text-green-700" : "bg-gray-900 text-white"}`}
                >
                  {settings.jobBabyMode ? "直接入职" : "参加面试"}
                </button>
              ) : activeInterview?.jobId === job.id ? (
                <button
                  onClick={() => navigate(`/work/interview/${job.id}`)}
                  className="mt-3 w-full rounded-lg bg-orange-50 py-2 text-sm text-orange-600"
                >
                  继续面试
                </button>
              ) : (
                <p className="mt-3 text-xs text-gray-400">
                  状态：
                  {job.status === "hired"
                    ? job.hiredBySkip
                      ? "宝宝模式直接录用"
                      : "已录用"
                    : job.status === "rejected"
                      ? "未录用"
                      : "面试中"}
                </p>
              )}
            </article>
          ))}
        </div>
        {jobs.length > 4 && (
          <div className="mx-4 mt-4 flex items-center justify-between">
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="rounded-lg bg-white px-4 py-2 text-sm disabled:opacity-30"
            >
              上一页
            </button>
            <span className="text-xs text-gray-400">
              {page + 1} / {Math.ceil(jobs.length / 4)}
            </span>
            <button
              disabled={(page + 1) * 4 >= jobs.length}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-lg bg-white px-4 py-2 text-sm disabled:opacity-30"
            >
              下一页
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
