# Usage Scenarios & Examples

This chapter answers two questions: which tasks suit the system, and how to phrase requirements for the best results.

## Information gathering

```
Collect ten important articles from the past week on
"multi-agent systems" into a Markdown report, grouped
by topic, with source links
```

The organization splits out searching, filtering, and summarizing; intermediate results go to the workspace, the final report comes back to you.

> State the quantity, time range, and output format — agents write these into the task's acceptance criteria.

## Software development

![软件团队](../../images/work.png)

```
Build a whack-a-mole web game with score and sound
```

The organization sets up frontend and testing roles; the output is a runnable web page — open it from the Artifacts panel, play, and give feedback for iteration.

Agents can also inject interfaces directly into the main window:

![天气挂件效果](../../images/天气挂件效果.png)

## Content operations

```
Write three promo copy variants in different styles for
our new product, each with a poster design brief
```

The built-in "content operation" template divides work into planning, writing, and review; output files land in the workspace for direct use.

## Browser automation

```
Open the Issues page of the agent_society GitHub repository
and count the open issues
```

Requires the chrome module. The agent opens the page, reads it, and reports.

## Local commands

```
Use ffmpeg to compress demo.mp4 in the workspace to 720p,
and tell me the output file size when done
```

Requires the localcmd module. During long tasks the agent keeps tracking progress.

## Remote operations

```
Deploy the website in the workspace to my configured server
and restart the service
```

Requires the ssh module with a configured host.

## GUI automation

```
Open the finance app and enter last month's expense
receipts one by one
```

With the automation module, agents operate desktop software (mouse, keyboard, window controls).

## Group discussion

```
Create a group with product, tech, and operations roles,
discuss next week's release plan, and summarize for me
```

For multi-party discussion with fast convergence.

## Long-term use

The system mirrors running a business: treat each organization as a company, with one difference — agents are virtual employees, and recruiting and firing costs nearly nothing. One role for each kind of work, with agents serving on it long term.

| Work type | Example role | Long-term usage |
|-----------|--------------|-----------------|
| Daily information gathering | Information collector | Have it collect and summarize daily; it remembers the topics you follow |
| Content creation | Copywriter | Continuous output with a consistent style and history |
| Data processing | Data analyst | Fixed pipeline; new data reuses it directly |
| Customer communication | Support | Records every conversation and follows up on past issues |

Key points:

1. **Fix one role per kind of work**: no need to re-explain the background; the agents on duty remember previous work;
2. **Adjust staffing as workload changes**: add agents to a role when overloaded, or give it sub-roles to share the load;
3. **Remove roles when the business shrinks**: delete roles for work no longer needed, keeping the organization lean;
4. **Give new requirements to the agents on duty first**: state the new requirement to an existing agent and let it decide whether to bring in collaborators.

## Writing requirements

**Good**: clear goal + clear output form + clear constraints

```
Create report.md in the workspace analyzing prices.xlsx:
1. Read prices.xlsx (I uploaded it to the workspace)
2. Compute monthly averages and volatility
3. Present results as a Markdown table with three conclusions
```

**Poor**: vague goal, no acceptance criteria

```
Take a look at this data
```

**General tips**:

1. Say what you want and what "done" means;
2. Upload needed files to the workspace first, and mention filenames in the requirement;
3. Split large tasks into stages: request a plan, confirm, then request implementation;
4. Send follow-up information as interruptions — cheaper than rework.

## Built-in org templates

Root references built-in templates when organizing; view, edit, and add them in the **Templates** manager:

| Template | Purpose |
|----------|---------|
| `software_develop` | Software development team |
| `content-operation` | Content operations |
| `information_collector` | Information gathering |
| `entrepreneur-team` | Startup team |
| `courseware` | Courseware production |
| `editorial-board` | Editorial board |
| `web-app-learn` | Web app learning |
| `virtual-world` | Virtual world |
| `Chinese_chess` | Chinese chess |

## FAQ

**Q: The task is heading the wrong way halfway through?**
Interrupt with a correction; for bigger drifts, have the agent stop (Abort), realign, and continue.

**Q: Complex tasks take a long time — is that normal?**
Yes. Org building, multi-agent collaboration, and tool calls all take time; watch the conversation flow to confirm progress.

**Q: Want the same team structure for a recurring task type?**
Put the task description and expected division of work into an org template; Root follows templates when organizing.

**Q: Want the same kind of work always done by the same agent?**
Say so directly in a requirement: "assign this work to xxx from now on". Agents serve long term and will remember how this work is done, solidifying it into skills.

**Q: Unhappy with a result — how to rework?**
Say what's wrong and what you expect; agents iterate within the existing organization. Output files stay in the workspace throughout.

## Next steps

- [Group Chat](06-group-chat.md)
- [Module Extensions](09-modules.md)
