/**
 * @file Daily-report system instruction (Phase 1 Req 15).
 *
 * Kept as a versioned constant in its own module so prompt tweaks are
 * diff-reviewable in isolation from the scheduler wiring. The runtime
 * appends this text to the AI's normal situational digest as the
 * `extraInstruction` of `runCycle`, so the model sees recent channel
 * activity + in-progress tasks BEFORE it is asked to summarise.
 */

/**
 * Bump when the wording materially changes so log/analytics consumers
 * can correlate report style with prompt version.
 */
export const DAILY_REPORT_PROMPT_VERSION = 1;

/**
 * The instruction appended to the cycle's initial context. Written in
 * Simplified Chinese to match the product's shipping locale and the
 * `buildGenericSystemPrompt` guidance ("write user-facing messages in
 * Simplified Chinese"). The closing line explicitly tells the model to
 * deliver the report via `send_channel_message` to `#general`, which
 * is how the report reaches the operator + the dashboard timeline.
 */
export const DAILY_REPORT_INSTRUCTION = [
  '现在是每日工作汇报时间。请基于以上频道动态和进行中的任务，撰写一份简洁的当日工作日报，包含三部分：',
  '1. 今天完成了什么（具体到任务/讨论）；',
  '2. 当前被什么阻塞、需要人工决策什么；',
  '3. 明天计划推进什么。',
  '',
  '保持简短（不超过 200 字），用要点而非长段落。',
  '写好后，调用 send_channel_message 把日报发到 #general 频道（使用上面列出的频道 id）。',
  '日报发送完成后即可结束，无需额外操作。',
].join('\n');
