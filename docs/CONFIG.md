# Configuration reference

limit-bar reads TOML (or JSON) and has no other way to be configured. Every built-in
module is also plain config: read [`src/defaults.toml`](../src/defaults.toml) to see
how each one is made, and copy any of it into your own file.

Check your work at any time:

```sh
limit-bar validate     # mistakes, with file and line numbers
limit-bar explain      # which files, rules and modules applied, and why
limit-bar fields       # every variable and its current value
```

## Where config lives

Later layers override earlier ones. Tables merge key by key. Arrays are replaced,
except `[[when]]` rules, which add up.

| Order | Source | Notes |
|---|---|---|
| 1 | Built-in defaults | `src/defaults.toml` |
| 2 | Theme | `~/.config/limit-bar/themes/NAME.toml`, then built-in themes |
| 3 | `~/.limit-bar.toml` | Optional, for people who keep one dotfile |
| 4 | `~/.config/limit-bar/conf.d/*.toml` | In name order, handy for dotfile managers |
| 5 | `~/.config/limit-bar/config.toml` | Your main file (`config.json` also works) |
| 6 | `.limit-bar.toml` in the project | Ignored until you run `limit-bar trust` |

Environment variables win over everything: `LIMITBAR_THEME`, `LIMITBAR_COLOR`,
`LIMITBAR_CHARSET`. `LIMITBAR_CONFIG=/path/file.toml` replaces layers 3 to 5, and
`LIMITBAR_NO_PROJECT=1` skips layer 6. `XDG_CONFIG_HOME` is respected, and `NO_COLOR`
turns colour off.

## Top-level keys

| Key | What it does |
|---|---|
| `theme` | Theme to build on |
| `[settings]` | Global options, below |
| `[palette]` | Named colours |
| `[style]` | Named styles |
| `[glyphs]` | Named symbols, per character set |
| `[bars.NAME]` | Gauge designs |
| `[var]` | Named expressions |
| `[source.NAME]` | Data from a command, file or environment variable |
| `[module.NAME]` | A piece of the bar |
| `[[line]]` | A row in the terminal. Your `[[line]]` replaces the theme's layout |
| `[[append_line]]` | A row added under the theme's layout, so it follows you between themes |
| `[[when]]` | A rule that overrides any of the above |

In a theme file, `extends = "other"` inherits from another theme and `description`
is shown by `limit-bar themes`. Themes cannot contain `[source]`, so a theme you
download can never run a command.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `charset` | `"unicode"` | `nerd`, `unicode` or `ascii`. Use `nerd` if your font has the glyphs |
| `color` | `"auto"` | `auto`, `truecolor`, `256`, `16` or `none` |
| `margin` | `4` | Columns left free on the right. Claude Code indents the bar by 2 and cuts text 2 columns before the edge |
| `warn` | `60` | `severity()` returns `warn` from this value |
| `hot` | `85` | `severity()` returns `hot` from this value |
| `bar` | `"block"` | Default gauge from `[bars]` |
| `sep` | two spaces | Default separator between modules |
| `git_ttl` | `2` | Seconds a git result is reused |
| `ctx_limit` | `100` | Percentage `ctx.eta` counts down to |
| `links` | `true` | Clickable links where the terminal supports them |
| `notices` | `true` | Show hints such as "run limit-bar trust" |

## Lines

Each `[[line]]` is one row. Rows with nothing to show disappear.

```toml
[[line]]
left   = ["model", "dir", "git"]
center = ["todo"]
right  = ["ctx", "cost"]
```

A side is a list of module names, a template string, or a list mixing both.

| Key | Meaning |
|---|---|
| `left`, `center`, `right` | What to show on each side |
| `sep`, `sep_style` | Separator template and its style |
| `mode` | `flat`, `powerline` (segments joined by arrows) or `capsule` (rounded chips) |
| `prefix`, `suffix` | Templates at the very ends, such as border characters |
| `fill`, `fill_style` | Character used to fill the gap between sides |
| `style` | Sits under everything on the line. With `full = true` and `on:COLOUR`, the theme brings its own background |
| `full` | `true` always uses the whole width |
| `keep` | `true` keeps the row even when it is empty |
| `if` | Expression. The row only shows when this is true |
| `min_width`, `max_width` | Only show the row within these terminal widths |

### When a line does not fit

limit-bar degrades one step at a time, least important module first:

1. Swap modules to their `compact` format.
2. Remove modules, lowest `priority` first.
3. Cut text with `…`, only if a single module is still too long.

## Modules

```toml
[module.ctx]
if = "ctx.pct != null"
format = "ctx {ctx.pct | bar:10} {ctx.pct | round}%"
compact = "ctx {ctx.pct | round}%"
style = "muted"
priority = 85
link = "https://example.com"
```

| Key | Meaning |
|---|---|
| `format` | Template to show |
| `compact` | Shorter template, used when space runs out |
| `if` | Expression. The module hides when this is false |
| `style` | Style, or `= expression` that returns a style |
| `priority` | 0 to 100, higher stays longer. Default 50 |
| `link` | Makes the module clickable. Only `http`, `https` and `file` are allowed |
| `disabled` | `true` turns it off |

A module that renders only blank space hides itself and takes its separator with it.

Built-in modules: `user`, `host`, `user_host`, `os`, `shell`, `load`, `model`, `effort`, `fast`, `thinking`, `output_style`, `agent`, `vim`,
`version`, `session`, `dir`, `path`, `project`, `repo`, `worktree`, `pr`, `git`,
`git_changes`, `git_sync`, `lines`, `ctx`, `ctx_tokens`, `ctx_trend`, `ctx_eta`, `h5`,
`h5_forecast`, `d7`, `spend`, `cost`, `cost_rate`, `duration`, `clock`, `cache`,
`cache_ttl`, `tool`, `agents`, `todo`.

## Templates

| Syntax | Meaning |
|---|---|
| `{ctx.pct}` | A variable |
| `{ctx.pct \| round \| lpad:3}` | A variable through filters, left to right |
| `{cost.usd * 83}` | Any expression |
| `{git}` | Another module, by bare name |
| `{if a}..{elif b}..{else}..{end}` | Conditional text |
| `<hot bold>text</>` | Styled text, can be nested |
| `<=severity(ctx.pct)>text</>` | Style chosen by an expression |
| `\{` `\<` `\\` | Literal characters |

Values placed into a template have all terminal control sequences removed, so a
hostile branch name or command output cannot affect your terminal.

In a `<=...>` tag, the closing `>` is the first one that is not followed by `=` and
not preceded by a space. So write comparisons as `a > b` or `a >= b`.

### Filters

<!-- filters -->
| Filter | Result |
|---|---|
| `round` | `round:1` sets decimal places |
| `fixed` | Fixed decimals, 2 by default |
| `money` | `$1.84`. `money:0` sets decimals |
| `tokens` | `1.5k`, `200k`, `1M` |
| `dur` | Seconds as `2h14m`. `dur:1` keeps one unit, `dur:2:'pad'` keeps a fixed width: `21h08m` |
| `clock` | Seconds as `47:10`, or `2:33:00` from one hour up |
| `upper` | Upper case |
| `lower` | Lower case |
| `title` | First letter upper case |
| `pad` | `pad:10` pads on the right. `pad:10:.` picks the character |
| `lpad` | `lpad:3` pads on the left |
| `trunc` | `trunc:20` cuts the end with `…` |
| `ltrunc` | `ltrunc:20` cuts the start with `…` |
| `basename` | Last part of a path |
| `default` | `default:none` replaces an empty value |
| `replace` | `replace:a:b` |
| `bar` | Gauge for 0 to 100. `bar:12` sets width, `bar:12:thin` picks the design |
| `spark` | Sparkline from a list. `spark:12` sets width, `spark:12:0:100` fixes the range |
| `frames` | `{time.epoch \| frames:'◐ ◓ ◑ ◒'}` picks a frame, for simple animation |
<!-- filters -->

## Expressions

Used by `if`, `[var]`, `= style`, `<=...>` and `{...}`. They are parsed and walked, never
passed to `eval`, and can only read variables.

Operators: `+ - * / %`, `== != > < >= <=`, `&& || !`, `??`, `a ? b : c`, `x in list`.

A missing value is `null` and never causes an error. Comparing `null` with `>` or `<`
is false, and arithmetic on it gives `null`.

<!-- funcs -->
| Function | Result |
|---|---|
| `severity` | `severity(v)` returns `ok`, `warn`, `hot`, or `muted` for null. `severity(v, 50, 80)` sets thresholds |
| `every` | `every(2)` flips every 2 seconds, for blinking |
| `min` | Smallest number |
| `max` | Largest number |
| `round` | `round(v, 1)` |
| `floor` | Round down |
| `ceil` | Round up |
| `abs` | Absolute value |
| `len` | Length of a string or list |
| `contains` | `contains(v, "x")` |
| `starts` | `starts(v, "x")` |
| `ends` | `ends(v, "x")` |
| `lower` | Lower case |
| `upper` | Upper case |
| `matches` | `matches(v, "^feat/")`, a regular expression |
| `concat` | Join values as text |
| `coalesce` | First value that is not null |
<!-- funcs -->

## Styles

A style is a list of words, applied left to right:

```toml
style = "#ff7a1a bold on:#102030 underline"
```

| Word | Meaning |
|---|---|
| `#rgb`, `#rrggbb`, `0`-`255`, `red`, `bright_blue` | Text colour |
| A `[palette]` or `[style]` name | That colour or style |
| `on:COLOR` or `bg:COLOR` | Background |
| `bold`, `dim`, `italic`, `underline`, `strike`, `reverse`, `blink` | Attributes |
| `grad:a,b,c` | Gradient across this piece of text |
| `beam:a,b,c` | Gradient across the whole terminal line, so separate pieces line up |
| `none` | Clear colours |

Colours are reduced automatically for 256 and 16 colour terminals.

## Gauges

```toml
[bars.mine]
fill = "█"
empty = "█"
track = true
partial = ["▏", "▎", "▍", "▌", "▋", "▊", "▉"]
color = "ramp"
ramp = ["ok", "warn", "hot"]
empty_style = "faint"
left = "["
right = "]"
cap_style = "muted"
```

| Key | Meaning |
|---|---|
| `fill`, `empty` | Characters for each part |
| `track` | Draws the empty part in solid colour, with no gap at the join. Falls back to `░` without colour |
| `partial` | Characters for sub-cell precision |
| `color` | `level` colours by severity, `ramp` colours each cell by position, `none` inherits |
| `ramp` | Colours for `ramp` |
| `empty_style`, `cap_style` | Styles for the empty part and the ends |
| `label` | `true` writes the percentage inside the gauge, centred. Takes whole cells, so `partial` is ignored |
| `label_fill`, `label_track` | Text colour of that percentage over the filled part and over the track |
| `dither` | With `label`, darkens every other cell by this much, 0 to 1, for a blocky look |
| `left`, `right` | End caps |

Built in: `block`, `thin`, `ticks`, `dots`, `ascii`. `ascii` is used automatically when
`charset = "ascii"`.

## Glyphs

```toml
[glyphs]
branch = { nerd = "\ue0a0", unicode = "⎇", ascii = "git:" }
```

Read them as `{g.branch}`. The current character set is picked automatically.

## Sources

Sources bring outside data into the bar.

```toml
[source.kube]
command = "kubectl config current-context"
every = "30s"
timeout = "3s"
```

| Key | Meaning |
|---|---|
| `command` | Shell command. Runs in a detached background process, never during a render |
| `file` | Read a file, up to 256 KB |
| `env` | Read an environment variable |
| `every` | How long a value stays fresh. Default `30s`. Accepts `ms`, `s`, `m`, `h`, `d` |
| `timeout` | Kill the command after this long. Default `5s` |
| `parse` | `text` (first line, the default), `lines`, or `json` |
| `scope` | Cache per `cwd` (default), `session` or `global` |

Read them as `source.NAME.value`, `.data` (parsed `json` or `lines`, so
`source.ci.data.0.status` works), `.ok`, `.stale`, `.age` and `.error`.

The first render after a value goes stale shows the old value and starts a refresh, so
a slow command can never delay the bar. A brand new source is empty until its first
run finishes.

## Rules

A `[[when]]` rule overrides anything when its condition is true. Rules run in order.

```toml
[[when]]
name = "take over when a limit is close"
if = "ctx.pct >= 85 || limit.h5.pct >= 85"
theme = "cockpit"

[[when]]
if = "git.branch == 'main'"
[when.palette]
accent = "#ff4d3d"
[when.module.git]
style = "hot bold"

[[when]]
if = "term.cols < 80"
stop = true
[[when.line]]
left = ["model", "ctx"]
```

| Key | Meaning |
|---|---|
| `if` | Expression. No `if` means always |
| `name` | Label shown by `limit-bar explain` |
| `theme` | Swap to another theme |
| `stop` | Skip the remaining rules |
| Any other key | Overrides that part of the config |

## Project config

A `.limit-bar.toml` in a project is ignored until you approve it with `limit-bar trust`, which
lists any commands it will run. The approval is tied to a hash of the file, so any
edit needs approving again. `limit-bar untrust` removes it.

## Variables

Times are in seconds. A value that is not available is `null`. `limit-bar fields` prints
all of these with live values.

<!-- vars -->
| Variable | Meaning |
|---|---|
| `model.id` | Model id |
| `model.name` | Display name |
| `model.short` | First word of the name |
| `effort.level` | Reasoning effort |
| `user.name` | Your username |
| `user.host` | Machine name, without `.local` |
| `user.home` | Home directory |
| `system.os` | `macOS`, `Linux` or `Windows` |
| `system.arch` | `arm64`, `x64`... |
| `system.shell` | Shell name, from `SHELL` |
| `system.cores` | CPU cores |
| `system.load` | One-minute load average |
| `system.node` | Node version running limit-bar |
| `dir.path` | Current directory |
| `dir.name` | Its last part |
| `dir.tilde` | With `~` for home |
| `dir.short` | Shortened, `~/c/orbit-api` |
| `project.path` | Directory the session started in |
| `project.name` | Its last part |
| `project.is_subdir` | Current directory differs from it |
| `project.relative` | Current directory relative to it |
| `project.added_dirs` | Count of added directories |
| `repo.host` | Remote host |
| `repo.owner` | Remote owner |
| `repo.name` | Remote name |
| `repo.slug` | `owner/name` |
| `repo.url` | Web address |
| `session.id` | Session id |
| `session.name` | Session name |
| `session.prompt_id` | Current prompt id |
| `vim.mode` | Vim mode |
| `agent.name` | Agent name |
| `pr.number` | Open PR number |
| `pr.url` | PR address |
| `pr.state` | Review state |
| `pr.kind` | PR or merge request |
| `worktree.name` | Worktree name |
| `worktree.path` | Worktree path |
| `worktree.branch` | Worktree branch |
| `worktree.original_branch` | Branch it came from |
| `ctx.pct` | Context used, percent |
| `ctx.left` | Context left, percent |
| `ctx.size` | Context window size |
| `ctx.tokens` | Tokens in context |
| `ctx.tokens_left` | Tokens remaining |
| `ctx.output` | Output tokens of the last response |
| `ctx.fresh` | Uncached input tokens |
| `ctx.cache_read` | Tokens read from cache |
| `ctx.cache_write` | Tokens written to cache |
| `ctx.eta` | Seconds until `ctx_limit` at the current rate |
| `cost.usd` | Session cost |
| `cost.duration` | Session length |
| `cost.api` | Time spent waiting on the API |
| `cost.added` | Lines added |
| `cost.removed` | Lines removed |
| `cost.lines` | Lines added plus removed |
| `cost.avg_per_hour` | Average cost per hour this session |
| `cost.per_hour` | Recent cost per hour |
| `limit.h5` | Five-hour window, `null` when absent |
| `limit.h5.pct` | Percent used |
| `limit.h5.resets_at` | Reset time, epoch seconds |
| `limit.h5.left` | Seconds until reset |
| `limit.h5.reset_clock` | Reset time, `17:40` |
| `limit.h5.elapsed` | Seconds of the window gone |
| `limit.h5.projected` | Percent at reset if the pace holds |
| `limit.h5.pace` | `projected / 100`, above 1 means over pace |
| `limit.h5.will_hit` | Pace reaches 100% before reset |
| `limit.h5.hit_in` | Seconds until 100% at this pace, if before reset |
| `limit.d7` | Seven-day window, `null` when absent |
| `limit.d7.pct` | As above |
| `limit.d7.resets_at` | As above |
| `limit.d7.left` | As above |
| `limit.d7.reset_clock` | As above |
| `limit.d7.elapsed` | As above |
| `limit.d7.projected` | As above |
| `limit.d7.pace` | As above |
| `limit.d7.will_hit` | As above |
| `limit.d7.hit_in` | As above |
| `limit.spend` | Gateway spend limit, `null` when absent |
| `limit.spend.pct` | As above |
| `limit.spend.resets_at` | As above |
| `limit.spend.left` | As above |
| `limit.spend.reset_clock` | As above |
| `limit.spend.elapsed` | As above |
| `limit.spend.projected` | As above |
| `limit.spend.pace` | As above |
| `limit.spend.will_hit` | As above |
| `limit.spend.hit_in` | As above |
| `limit.spend.usd` | Estimated spend |
| `limit.spend.max` | Spend limit |
| `limit.spend.period` | `daily`, `weekly` or `monthly` |
| `cache.known` | Cache data is present |
| `cache.warm` | Cached prefix is still live |
| `cache.observed` | Caching seen this session |
| `cache.ttl` | `5m` or `1h` |
| `cache.expires_at` | Expiry, epoch seconds |
| `cache.left` | Seconds until the cache goes cold |
| `cache.hit` | Hit ratio, percent |
| `cache.requests` | Requests counted |
| `cache.misses` | Cache misses |
| `cache.rebuilds` | Expected rebuilds |
| `cache.written` | Tokens written |
| `cache.wasted` | Tokens re-cached by misses |
| `cache.cold_cost` | Tokens to re-cache if it goes cold |
| `cache.last_miss_at` | Last miss, epoch seconds |
| `cache.last_cause` | Likely cause of the last miss |
| `git.repo` | In a git repository |
| `git.branch` | Branch, or short hash when detached |
| `git.detached` | HEAD is detached |
| `git.oid` | Short commit hash |
| `git.upstream` | Upstream branch |
| `git.ahead` | Commits ahead |
| `git.behind` | Commits behind |
| `git.staged` | Staged files |
| `git.modified` | Modified files |
| `git.untracked` | Untracked files |
| `git.conflicts` | Conflicted files |
| `git.changed` | All of the above |
| `git.dirty` | Anything changed |
| `git.clean` | Nothing changed |
| `history.ctx` | Recent context percentages, for `spark` |
| `history.cost` | Recent cost values |
| `history.h5` | Recent five-hour values |
| `history.d7` | Recent seven-day values |
| `history.tokens` | Recent token counts |
| `rate.ctx_per_min` | Context growth, percent per minute |
| `rate.cost_per_hour` | Recent cost per hour |
| `rate.h5_per_hour` | Five-hour use, percent per hour |
| `rate.tokens_per_min` | Token growth per minute |
| `tool.active` | Tool running now |
| `tool.target` | What it is working on |
| `tool.running` | Tools running |
| `tool.agents` | Subagents running |
| `todo.done` | Finished todos |
| `todo.total` | All todos |
| `todo.current` | Todo in progress |
| `todo.pct` | Percent finished |
| `term.cols` | Terminal width |
| `term.lines` | Terminal height |
| `term.program` | Terminal program |
| `term.ssh` | Over SSH |
| `term.tmux` | Inside tmux |
| `time.epoch` | Now, epoch seconds |
| `time.hour` | Hour |
| `time.minute` | Minute |
| `time.second` | Second |
| `time.weekday` | `mon`, `tue`... |
| `time.weekend` | Saturday or Sunday |
| `time.date` | `2026-11-03` |
| `time.clock` | `14:05` |
<!-- vars -->

Also available: `fast`, `thinking`, `output_style`, `version`, `g.*` for glyphs,
`var.*`, `source.*`, `env.NAME`, and `raw.*`, which is the exact data sent by Claude Code.

`tool.*` and `todo.*` are read from the end of the session transcript. Its format is not a
public contract, so these are best effort and stay empty if it changes.
