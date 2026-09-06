# Quick Start

A complete first tour of agent collaboration.

## Step 1: Confirm the service is ready

Open the interface and confirm the LLM status in the top-right corner shows **connected**. If not, complete the setup dialog first.

## Step 2: Submit your first requirement

![输入需求](../../images/输入需求.png)

Type in the chat box, for example:

```
Check today's weather in Beijing and suggest what to wear
```

Press send.

## Step 3: Watch the organization

![首页](../../images/首页.png)

Root creates a role and an owner agent, and hands over the task. The **Organization** panel shows the role tree and agent states in real time:

![组织架构](../../images/组织架构.png)

## Step 4: Interact

- **Interrupt**: add information any time; the agent sees it during processing;
- **Watch collaboration**: complex tasks involve several agents, and the conversation flow shows their exchanges;
- **Check status**: badges next to avatars show idle / waiting-for-LLM / processing.

## Step 5: Receive the result

![查天气](../../images/查天气.png)

When the task completes, the result appears in the chat. For file outputs (e.g. an HTML report), view them in the **Artifacts** panel or open them in the browser.

## Step 6: Manage outputs

![推荐旅游路线报告](../../images/推荐旅游路线报告HTML内容.png)

The Artifacts panel previews files of all kinds, edits text online, and uploads files for agents to use.

![工作](../../images/work.png)

## Step 7: Long-term use

The organization does not disappear when the task finishes; the agents stay on their roles. From then on:

- Give the same kind of work to the same agent and continue from last time (it remembers the context);
- When workload grows, add agents to a role or add sub-roles in the organization view;
- When a kind of work is no longer needed, delete its role and its agents terminate with it.

## More examples

| Example requirement | Type |
|---------------------|------|
| `Build a snake web game` | Software development |
| `Collect ten important AI news items from the past week into a report` | Information gathering |
| `Create a group of three to discuss our product's marketing strategy` | Group chat |

## Tips

1. **Be specific**: state the goal, output form, and constraints;
2. **Don't rush to interrupt**: complex tasks take time — watch the conversation flow;
3. **Use interruptions**: key information mid-task beats post-hoc rework;
4. **Stage large tasks**: request a plan first, confirm, then request implementation.

## FAQ

**Q: Nothing happens after I send?**
Check the LLM status; check the error toast details.

**Q: The agent created a lot of agents — normal?**
Complex tasks split into several roles. If it feels excessive, say "no need for so many roles, do it yourself".

**Q: I want it to stop?**
Org view → agent properties → Abort; or just say so in a message.

**Q: Where are the output files?**
Artifacts panel; also on disk under `agent-society-data/workspaces/`.

**Q: Should I delete the organization once the task is done?**
No. Organizations and agents persist; continue with them for similar work. When truly no longer needed, delete the role in the organization view.

## Next steps

- [Web Interface Guide](04-web-interface.md) — every area of the interface
- [Usage Scenarios & Examples](05-usage-scenarios.md) — more scenarios
