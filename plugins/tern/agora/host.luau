-- host.luau: the Agora pane (block `agora.room`) and the lenses for agora's own commands.
--
-- The block draws what `bridge.mjs` reads: five tabs over one room read.
--   1 Room      the room's subjects newest activity first with unread marks, a conversation view,
--               who has spoken, and one compose card that states where a post goes
--   2 Search    the loaded messages filtered by text, author or trailer, and how far the read reaches
--   3 Board     claims, verdicts and who spoke, from the trailers of the messages read
--   4 Rooms     every room the pane offers, with each native room's committed boundary and faces
--   5 Seat      this seat's service, its human, the configured residents and the sessions here
-- Posts are a person's: as this seat's human (native and local rooms, in process), through the
-- CLI, or through a configured post command (a member seat's human). Nothing here types into a
-- pane or drives an agent; it never calls `tern.pane.write`.
--
-- An open block reads its room again every `intervalMs`. The chain of one-shot timers ends when the
-- block's pane is gone, so a closed block leaves nothing running.

local ui = tern.ui

local BRIDGE = tern.plugin.dir .. "/bridge.mjs"
local DATA = tern.plugin.data
local LAST_VIEW = DATA .. "/last-view.json"
local NODE = tern.getenv("AGORA_TERN_NODE") or "node"
local BRIDGE_TIMEOUT_MS = 30000
local DEFAULT_INTERVAL_MS = 25000
local SUBJECTS_PAGE = 20
local THREAD_TAIL = 12
local TO_CHIPS = 6
local SEARCH_LIMIT = 50

local MODES = { "room", "search", "board", "rooms", "peers" }
local MODE_TABS = {
	{ id = "room", key = "1", label = "Room & threads" },
	{ id = "search", key = "2", label = "Search & horizon" },
	{ id = "board", key = "3", label = "Board & who" },
	{ id = "rooms", key = "4", label = "Rooms & faces" },
	{ id = "peers", key = "5", label = "Peers, service & residents" },
}

-- ---------------------------------------------------------------------------------------------
-- The bridge
-- ---------------------------------------------------------------------------------------------

-- Runs `node bridge.mjs <args> --data <data folder>`, `input` as JSON on its stdin, and calls `cb` with
-- the decoded object (and the raw text), or `{ ok = false, error = ... }` when it could not run or
-- did not answer in JSON.
local function bridge(args: { string }, input: any, cb: (any, string?) -> ())
	local argv = { NODE, BRIDGE }
	for _, a in ipairs(args) do
		table.insert(argv, a)
	end
	table.insert(argv, "--data")
	table.insert(argv, DATA)
	local opts: any = { timeout_ms = BRIDGE_TIMEOUT_MS }
	if input ~= nil then
		opts.stdin = tern.json.encode(input)
	end
	local started = pcall(tern.process.run, argv, opts, function(res)
		if res.timed_out then
			cb({ ok = false, error = "the agora bridge did not answer in time" })
			return
		end
		if res.status ~= 0 then
			local said = string.match(res.stderr or "", "([^\r\n]+)%s*$") or ("exit " .. tostring(res.status))
			if string.find(res.stderr or "", "ERR_MODULE_NOT_FOUND", 1, true) then
				said = "the plugin is not in an agora checkout: link it from one (tern plugin link <checkout>/plugins/tern/agora)"
			end
			cb({ ok = false, error = "the agora bridge failed: " .. string.sub(said, 1, 240) })
			return
		end
		local ok, decoded = pcall(tern.json.decode, res.stdout or "")
		if ok and type(decoded) == "table" then
			cb(decoded, res.stdout)
		else
			cb({ ok = false, error = "the agora bridge printed something that is not JSON" })
		end
	end)
	if not started then
		cb({ ok = false, error = "could not start `" .. NODE .. "` (set AGORA_TERN_NODE to the node executable)" })
	end
end

-- ---------------------------------------------------------------------------------------------
-- What is read, kept per room in tern.kv (key `read_state`):
--   { [room] = { seen = { [subjectId] = lastMessageIdSeen }, baselineId = <id>, hasBaseline = true } }
-- The first read of a room sets the baseline, so opening it the first time marks nothing unread.
-- The window half reads `status` ({ room, new }) for its status-line segment.
-- ---------------------------------------------------------------------------------------------

local function read_state_all(): any
	local ok, v = pcall(tern.kv.get, "read_state")
	if ok and type(v) == "table" then
		return v
	end
	return {}
end

local function room_state(room: string): any
	local rs = read_state_all()[room]
	if type(rs) ~= "table" then
		return { seen = {}, hasBaseline = false }
	end
	if type(rs.seen) ~= "table" then
		rs.seen = {}
	end
	return rs
end

local function save_room_state(room: string, rs: any)
	local all = read_state_all()
	all[room] = rs
	pcall(tern.kv.set, "read_state", all)
end

-- ---------------------------------------------------------------------------------------------
-- State
-- ---------------------------------------------------------------------------------------------

local function new_state(room: string?, mode: string?): any
	return {
		room = room,
		mode = mode or "room",
		view = nil, -- the last good read of `room`
		loading = false,
		again = false, -- a read was asked for while one was running
		refresh_remote = false,
		posting = false,
		busy = nil, -- a seat action running
		seat_output = nil,
		error = nil,
		flash = nil,
		read_at = nil,
		thread = nil, -- the subject open: the compose card's target; nil is a new subject
		selected = nil, -- the row the keyboard is on; never a target
		limit = SUBJECTS_PAGE,
		earlier = false,
		who_open = false,
		typing = false,
		draft = "",
		to = "auto", -- "auto" (a thread's agents), "" the room, "*" everyone, or a name
		search = "",
		search_typing = false,
		interval = DEFAULT_INTERVAL_MS,
		poll_on = false,
		poll_dead = false,
	}
end

local function subjects_of(state: any): { any }
	return (state.view and state.view.subjects) or {}
end

local function find_subject(state: any, id: string?): any
	if id == nil then
		return nil
	end
	for _, s in ipairs(subjects_of(state)) do
		if s.id == id then
			return s
		end
	end
	return nil
end

local function unread_subjects(state: any): number
	local n = 0
	for _, s in ipairs(subjects_of(state)) do
		if (tonumber(s.unread) or 0) > 0 then
			n += 1
		end
	end
	return n
end

local function publish_status(state: any)
	if state.room == nil then
		return
	end
	pcall(tern.kv.set, "status", { room = state.room, new = unread_subjects(state) })
	pcall(tern.kv.set, "last_room", state.room)
end

-- ---------------------------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------------------------

local function mark_seen(state: any, subject: any)
	if subject == nil or state.room == nil then
		return
	end
	local rs = room_state(state.room)
	if rs.seen[subject.id] ~= subject.latestId then
		rs.seen[subject.id] = subject.latestId
		save_room_state(state.room, rs)
	end
	subject.unread = 0
	publish_status(state)
end

local function take_view(state: any, view: any, raw: string?)
	local room: string = view.room
	local rs = room_state(room)
	local dirty = false
	if not rs.hasBaseline then
		rs.baselineId = view.baselineId
		rs.hasBaseline = true
		dirty = true
	end
	-- an open thread counts as read as it grows
	if state.thread ~= nil then
		for _, s in ipairs(view.subjects or {}) do
			if s.id == state.thread and rs.seen[s.id] ~= s.latestId then
				rs.seen[s.id] = s.latestId
				s.unread = 0
				dirty = true
			end
		end
	end
	-- marks for subjects that have left the window are dropped
	local present = {}
	for _, s in ipairs(view.subjects or {}) do
		present[s.id] = true
	end
	for id, _ in pairs(rs.seen) do
		if not present[id] then
			rs.seen[id] = nil
			dirty = true
		end
	end
	if dirty then
		save_room_state(room, rs)
	end
	state.room = room
	state.view = view
	state.read_at = tern.now()
	state.error = nil
	if state.thread ~= nil and find_subject(state, state.thread) == nil and #(view.subjects or {}) > 0 then
		-- the subject left the window: back to the list, the target stated again there
		state.thread = nil
	end
	if raw ~= nil then
		pcall(tern.fs.write, LAST_VIEW, raw)
	end
	publish_status(state)
end

local function refresh(state: any, cx: BlockCx, quiet: boolean?)
	if state.loading then
		state.again = true
		return
	end
	state.loading = true
	local room: string? = state.room
	local args = { "view" }
	if room ~= nil then
		table.insert(args, "--room")
		table.insert(args, room)
	end
	if state.refresh_remote then
		table.insert(args, "--refresh-remote")
		state.refresh_remote = false
	end
	local rs = room_state(room or "")
	bridge(args, {
		seen = rs.seen,
		baselineId = rs.baselineId,
		hasBaseline = room ~= nil and rs.hasBaseline == true,
		self = state.view and state.view.room == room and state.view.self or nil,
	}, function(res, raw)
		state.loading = false
		if res.ok then
			-- a room switched to while this read ran is read next; this one is not shown
			if state.room == nil or res.room == state.room or room == nil then
				take_view(state, res, raw)
			end
		else
			state.error = tostring(res.error or "the room could not be read")
		end
		local again = state.again or (state.room ~= nil and state.view ~= nil and state.view.room ~= state.room)
		state.again = false
		if again then
			refresh(state, cx, true)
		end
		pcall(function()
			cx:render()
		end)
	end)
	if not quiet then
		cx:render()
	end
end

-- One block, one chain of one-shot timers. Each tick asks whether the block is still there, and
-- the chain ends, scheduling nothing again, when it is not: the window half records a closed Agora
-- pane in kv `closed` (a block has no close hook of its own, and the host's pane list can keep
-- a closed block), and a repaint that raises or a pane gone from the host's list says the same.
local function block_alive(cx: BlockCx): boolean
	local ok_c, closed = pcall(tern.kv.get, "closed")
	if ok_c and type(closed) == "table" and closed[tostring(cx.pane)] then
		closed[tostring(cx.pane)] = nil
		pcall(tern.kv.set, "closed", closed)
		return false
	end
	if not pcall(function()
		cx:render()
	end) then
		return false
	end
	local ok, panes = pcall(tern.pane.list)
	if ok and type(panes) == "table" then
		for _, p in ipairs(panes) do
			if p.pane == cx.pane then
				return true
			end
		end
		return false
	end
	return true
end

local function poll_tick(state: any, cx: BlockCx)
	if state.poll_dead then
		return
	end
	if not block_alive(cx) then
		state.poll_dead = true
		return
	end
	if not state.loading and not state.posting and not state.typing then
		refresh(state, cx, true)
	end
	tern.timer(state.interval, function()
		poll_tick(state, cx)
	end)
end

local function poll_start(state: any, cx: BlockCx)
	if state.poll_on then
		return
	end
	state.poll_on = true
	bridge({ "config" }, nil, function(res)
		if res.ok and tonumber(res.intervalMs) then
			state.interval = tonumber(res.intervalMs) :: number
		end
		tern.timer(state.interval, function()
			poll_tick(state, cx)
		end)
	end)
end

-- ---------------------------------------------------------------------------------------------
-- Posting. The target is what the compose card says when Post is pressed: the open subject or a
-- new one, and whom it is addressed to.
-- ---------------------------------------------------------------------------------------------

local function trim(s: string): string
	local t = string.gsub(s, "^%s+", "")
	t = string.gsub(t, "%s+$", "")
	return t
end

-- Whom the post is addressed to, as names: what the card shows under `to`.
local function addressees(state: any): { string }
	if state.to == "auto" then
		local s = state.thread and find_subject(state, state.thread)
		return (s and s.autoTo) or {}
	elseif state.to == "" then
		return {}
	end
	return { state.to }
end

local function send(state: any, cx: BlockCx)
	if state.posting then
		return
	end
	local text = trim(state.draft or "")
	if text == "" then
		state.flash = "nothing to post yet"
		state.flash_warn = true
		return
	end
	if state.room == nil then
		return
	end
	local room: string = state.room
	local thread: string? = state.thread
	local args = { "post", "--room", room }
	if thread ~= nil then
		table.insert(args, "--thread")
		table.insert(args, thread)
	end
	for _, a in ipairs(addressees(state)) do
		table.insert(args, "--to")
		table.insert(args, a)
	end
	state.posting = true
	state.error = nil
	state.flash = nil
	bridge(args, { text = text }, function(res)
		state.posting = false
		if res.ok then
			state.draft = ""
			state.typing = false
			local to = (type(res.to) == "table" and #res.to > 0) and (" to " .. table.concat(res.to, ", ")) or ""
			state.flash = "posted to " .. room .. to
			state.flash_warn = false
			-- a post that opened a subject is that subject's thread from now on
			if thread == nil and type(res.receipt) == "table" and res.receipt.id ~= nil then
				state.selected = res.receipt.id
			end
			pcall(function()
				cx:toast("success", "Posted to " .. room, to ~= "" and trim(to) or "addressed to the room")
			end)
			state.refresh_remote = true
			refresh(state, cx, true)
		else
			state.error = tostring(res.error or "the post failed")
			pcall(function()
				cx:toast("error", "Not posted (the draft is kept)", state.error)
			end)
		end
		pcall(function()
			cx:render()
		end)
	end)
end

local SEAT_LABELS = {
	["service-start"] = "start the seat service",
	["service-stop"] = "stop the seat service",
	["resident-cycle-dry"] = "resident cycle --all --dry-run",
	["prune-sessions-dry"] = "session --prune --dry-run",
}

local function seat_action(state: any, verb: string, cx: BlockCx)
	if state.busy ~= nil or SEAT_LABELS[verb] == nil then
		return
	end
	state.busy = verb
	state.seat_output = nil
	bridge({ verb }, nil, function(res)
		state.busy = nil
		state.seat_output = { verb = verb, ok = res.ok == true, text = tostring(res.output or res.error or "") }
		pcall(function()
			if res.ok then
				cx:toast("success", "agora " .. SEAT_LABELS[verb])
			else
				cx:toast("error", "agora " .. SEAT_LABELS[verb] .. " failed", tostring(res.error or ""))
			end
		end)
		refresh(state, cx, true)
	end)
	cx:render()
end

-- ---------------------------------------------------------------------------------------------
-- Drawing helpers
-- ---------------------------------------------------------------------------------------------

local function button(key: string, label: string, action: string, class: string?): any
	return ui.el("button", { key = key, class = "ag-btn" .. (class and (" " .. class) or ""), actions = { click = action }, text = label })
end

local function chip(key: string, label: string, action: string, on: boolean): any
	return ui.el("button", { key = key, class = on and "ag-chip on" or "ag-chip", actions = { click = action }, text = label })
end

local function read_age(ms: number?): string
	if ms == nil then
		return "not read yet"
	end
	local s = math.max(0, math.floor((tern.now() - ms) / 1000))
	if s < 90 then
		return "read " .. tostring(s) .. "s ago"
	end
	return "read " .. tostring(math.floor(s / 60)) .. "m ago"
end

-- "MM-DD HH:MM" from "YYYY-MM-DD HH:MM:SS", for table cells.
local function short_ts(ts: any): string
	local t = tostring(ts or "")
	return #t >= 16 and string.sub(t, 6, 16) or t
end

-- The sequence a cursor ends in (`<room id>:<n>` → `n`), the part a person compares.
local function cursor_tail(c: any): string
	local t = tostring(c or "")
	return string.match(t, ":(%d+)$") or t
end

-- A table whose rows may be clicked: `row_actions[i]` names the action of row i.
local function data_table(key: string, cols: { any }, rows: { { any } }, row_actions: { [number]: string }?): Node
	local ths = {}
	for ci, col in ipairs(cols) do
		table.insert(ths, ui.el("th", { key = "th" .. tostring(ci), class = (col.align == "end") and "ag-th end" or "ag-th", text = tostring(col.head or "") }))
	end
	local trs = {}
	for ri, r in ipairs(rows) do
		local tds = {}
		for ci, col in ipairs(cols) do
			local cell = r[ci]
			table.insert(tds, ui.el("td", { key = "c" .. tostring(ci), class = (col.align == "end") and "ag-td end" or "ag-td" }, { ui.text(cell ~= nil and cell or "") }))
		end
		local act = row_actions and row_actions[ri]
		table.insert(trs, ui.el("tr", { key = "r" .. tostring(ri), class = act and "ag-tr click" or "ag-tr", actions = act and { click = act } or nil }, tds))
	end
	return ui.el("table", { key = key, class = "ag-table" }, {
		ui.el("thead", { key = "h" }, { ui.el("tr", { key = "hr" }, ths) }),
		ui.el("tbody", { key = "b" }, trs),
	})
end

local function section(key: string, head: string, sub: string?, children: { Node }, head_class: string?): Node
	local kids = {
		ui.el("div", { key = key .. "_h", class = "ag-section-head" }, {
			ui.el("span", { key = "t", class = head_class or "ag-label", text = head }),
			sub and ui.el("span", { key = "s", class = "ag-caption", text = sub }) or nil,
		}),
	}
	for _, c in ipairs(children) do
		table.insert(kids, c)
	end
	return ui.el("div", { key = key, class = "ag-section" }, kids)
end

local function empty(key: string, text: string): Node
	return ui.el("div", { key = key, class = "ag-caption", text = text })
end

-- ---------------------------------------------------------------------------------------------
-- Header: the room, how fresh the read is, the tabs, the room chips
-- ---------------------------------------------------------------------------------------------

local function render_header(state: any): Node
	local view = state.view
	local status = state.loading and "reading…" or read_age(state.read_at)
	if view and view.transport and view.transport ~= "" then
		status = view.transport .. " · " .. status
	end
	local new_n = unread_subjects(state)
	local tabs = {}
	for _, t in ipairs(MODE_TABS) do
		local label = t.key .. " " .. t.label
		if t.id == "room" and new_n > 0 then
			label = label .. " · " .. tostring(new_n) .. " new"
		end
		table.insert(tabs, ui.el("button", { key = "tab_" .. t.id, class = (state.mode == t.id) and "ag-tab on" or "ag-tab", actions = { click = "mode=" .. t.id }, text = label }))
	end
	local rooms = (view and view.rooms) or {}
	local chips = {}
	if #rooms > 1 then
		for _, r in ipairs(rooms) do
			table.insert(chips, chip("room_" .. tostring(r.alias), tostring(r.alias), "room=" .. tostring(r.alias), r.alias == state.room))
		end
	end
	return ui.el("div", { key = "head", class = "ag-head" }, {
		ui.el("div", { key = "brand", class = "ag-brand" }, {
			ui.el("span", { key = "room", class = "ag-heading", text = state.room or "Agora" }),
			ui.el("div", { key = "right", class = "ag-row" }, {
				ui.el("span", { key = "status", class = "ag-caption", text = status }),
				button("refresh", "Refresh", "refresh", "quiet"),
				button("close", "Close", "close", "quiet"),
			}),
		}),
		ui.el("div", { key = "tabs", class = "ag-tabs" }, tabs),
		#chips > 0 and ui.el("div", { key = "rooms", class = "ag-chips" }, chips) or nil,
	})
end

local function render_alerts(state: any): { Node }
	local out = {}
	local view = state.view
	if view and type(view.fault) == "table" and view.fault.reason then
		local kids = { ui.el("span", { key = "t", text = "room " .. tostring(view.fault.kind or "dark") .. " · " .. tostring(view.fault.reason) }) }
		if view.transport == "native" and view.fault.kind == "dark" then
			table.insert(kids, button("fault_start", "Start the seat service", "seat=service-start", "primary"))
		end
		table.insert(out, ui.el("div", { key = "fault", class = (view.fault.kind == "dark") and "ag-alert bad" or "ag-alert warn" }, kids))
	end
	if state.error ~= nil then
		table.insert(out, ui.el("div", { key = "error", class = "ag-alert bad" }, { ui.el("span", { key = "t", text = state.error }) }))
	end
	for i, p in ipairs((view and view.problems) or {}) do
		table.insert(out, ui.el("div", { key = "prob_" .. tostring(i), class = "ag-caption warn", text = tostring(p) }))
	end
	if state.flash ~= nil then
		table.insert(out, ui.el("div", { key = "flash", class = state.flash_warn and "ag-caption warn" or "ag-caption ok", text = state.flash }))
	end
	return out
end

-- ---------------------------------------------------------------------------------------------
-- Tab 1: Room & threads
-- ---------------------------------------------------------------------------------------------

local function render_presence(state: any): Node
	local view = state.view
	local who = (view and view.board and view.board.who) or {}
	local watching = (view and view.watching) or {}
	if #who == 0 then
		return empty("who0", state.loading and "who has spoken: …" or "nobody has spoken in the messages read")
	end
	local names = {}
	for i, w in ipairs(who) do
		if i > 5 then
			table.insert(names, "+" .. tostring(#who - 5))
			break
		end
		table.insert(names, tostring(w.speaker))
	end
	local summary = (state.who_open and "▾ " or "▸ ") .. tostring(#who) .. " spoke · " .. table.concat(names, ", ")
	if #watching > 0 then
		summary = summary .. " · " .. tostring(#watching) .. " watching from this seat"
	end
	local kids = { button("who", summary, "who", "quiet wide") }
	if state.who_open then
		local rows = {}
		for i, w in ipairs(who) do
			local line = string.format("%s · %d %s · last %s", tostring(w.speaker), tonumber(w.count) or 0, (tonumber(w.count) or 0) == 1 and "message" or "messages", tostring(w.lastTs or ""))
			if w.origin and w.origin ~= "" then
				line = line .. " · " .. tostring(w.origin)
			end
			if w.watching then
				line = line .. " · watching from this seat"
			end
			table.insert(rows, ui.el("div", { key = "w" .. tostring(i), class = "ag-caption", text = line }))
		end
		table.insert(rows, ui.el("div", { key = "wnote", class = "ag-caption", text = "from the messages read, not presence; watchers on other seats are not visible" }))
		table.insert(kids, ui.el("div", { key = "wlist", class = "ag-indent" }, rows))
	end
	return ui.el("div", { key = "presence", class = "ag-presence" }, kids)
end

local function to_label(state: any): string
	if state.to == "auto" then
		local names = addressees(state)
		if state.thread == nil or #names == 0 then
			return "the room"
		end
		return table.concat(names, ", ")
	elseif state.to == "" then
		return "the room"
	elseif state.to == "*" then
		return "everyone (*)"
	end
	return state.to
end

local function render_compose(state: any): Node
	local view = state.view
	local subject = state.thread and find_subject(state, state.thread)
	local where = state.thread == nil and "new subject" or ((subject and (subject.fullTitle or subject.title)) or state.thread)
	local kids = {
		ui.el("div", { key = "target", class = "ag-target", text = "Posting to " .. tostring(state.room or "?") .. " › " .. tostring(where) }),
	}

	-- whom it is for: the thread's agents, the room, everyone, or one of the last to have spoken
	local chips = {}
	if state.thread ~= nil then
		local auto = (subject and subject.autoTo) or {}
		table.insert(chips, chip("to_auto", #auto > 0 and ("thread: " .. table.concat(auto, ", ")) or "thread: nobody", "to=auto", state.to == "auto"))
	end
	table.insert(chips, chip("to_room", "the room", "to=", state.to == "" or (state.thread == nil and state.to == "auto")))
	table.insert(chips, chip("to_all", "everyone (*)", "to=*", state.to == "*"))
	local shown, present = 0, false
	for _, w in ipairs((view and view.board and view.board.who) or {}) do
		local name = tostring(w.speaker)
		if w.kind ~= "human" and name ~= (view and view.self) and not string.find(name, " as ", 1, true) and shown < TO_CHIPS then
			shown += 1
			present = present or name == state.to
			table.insert(chips, chip("to_" .. name, name, "to=" .. name, name == state.to))
		end
	end
	if state.to ~= "" and state.to ~= "*" and state.to ~= "auto" and not present then
		table.insert(chips, chip("to_cur", state.to, "to=" .. state.to, true))
	end
	table.insert(kids, ui.el("div", { key = "to", class = "ag-field" }, {
		ui.el("span", { key = "l", class = "ag-field-label", text = "to" }),
		ui.el("div", { key = "c", class = "ag-chips" }, chips),
	}))

	local field
	if state.typing then
		field = ui.node("editor", {
			key = "editor",
			text = state.draft,
			cursor = #state.draft,
			placeholder = "Enter posts · Shift+Enter new line · Esc stops writing",
			prompt = "❯ ",
		})
	else
		field = ui.el("div", { key = "idle", class = state.draft ~= "" and "ag-draft" or "ag-draft empty", actions = { click = "type" }, text = state.draft ~= "" and state.draft or "press i or click to write" })
	end
	table.insert(kids, ui.el("div", { key = "msg", class = "ag-field" }, {
		ui.el("span", { key = "l", class = "ag-field-label", text = "message" }),
		field,
	}))

	local btns = {
		button("post", state.posting and "Posting…" or "Post", "post", "primary"),
		button("write", state.typing and "Done" or "Write", state.typing and "done" or "type"),
		button("clear", "Clear", "clear", "quiet"),
	}
	if state.thread ~= nil then
		table.insert(btns, button("new", "New subject", "new", "quiet"))
	end
	table.insert(kids, ui.el("div", { key = "btns", class = "ag-row" }, btns))

	local human = view and view.human
	local posting = view and view.posting
	local as_line
	if posting and posting.via ~= "command" and human and human.needsName then
		as_line = ui.el("div", { key = "as", class = "ag-row" }, {
			ui.el("span", { key = "t", class = "ag-caption warn", text = "This seat's human has no name yet, so nothing can be posted." }),
			button("name", "Set your name", "name", "primary"),
		})
	else
		local who = (view and view.self) or "?"
		as_line = ui.el("div", { key = "as", class = "ag-caption", text = "as " .. tostring(who) .. ((posting and posting.detail and posting.detail ~= "") and (" · " .. posting.detail) or "") .. " · to: " .. to_label(state) })
	end
	table.insert(kids, as_line)
	return ui.el("div", { key = "compose", class = "ag-card" }, kids)
end

local function render_subjects(state: any): Node
	local subjects = subjects_of(state)
	local total = #subjects
	local shown = math.min(total, state.limit)
	local with_new = unread_subjects(state)
	local head = "Subjects"
	if total > 0 then
		head = string.format("Subjects · %d of %d", shown, total)
	end
	local rows = {}
	if total == 0 then
		table.insert(rows, empty("sempty", state.loading and "reading the room…" or "no messages in the window"))
	end
	for i = 1, shown do
		local s = subjects[i]
		local unread = tonumber(s.unread) or 0
		local mark = unread > 0 and "●" or ((s.id == state.selected) and "▸" or "")
		local cls = "ag-subject"
		if unread > 0 then
			cls = cls .. " unread"
		end
		if s.id == state.selected then
			cls = cls .. " sel"
		end
		local meta_kids = {}
		if unread > 0 then
			table.insert(meta_kids, ui.el("span", { key = "n", class = "ag-new", text = tostring(unread) .. " new" }))
		end
		table.insert(meta_kids, ui.el("span", { key = "m", text = tostring(s.meta) }))
		table.insert(rows, ui.el("div", { key = "s_" .. s.id, class = cls, actions = { click = "open=" .. s.id } }, {
			ui.el("span", { key = "mk", class = "ag-mark", text = mark }),
			ui.el("div", { key = "tx", class = "ag-subject-text" }, {
				ui.el("div", { key = "t", class = "ag-subject-title", text = tostring(s.title) }),
				ui.el("div", { key = "m", class = "ag-subject-meta" }, meta_kids),
			}),
		}))
	end
	if total > shown then
		local left = total - shown
		table.insert(rows, button("more", string.format("Show %d more (%d older)", math.min(SUBJECTS_PAGE, left), left), "more", "quiet wide"))
	end
	return section("subjects", head, with_new > 0 and (tostring(with_new) .. " with new messages") or "newest activity first", rows)
end

local function render_thread(state: any): Node
	local s = find_subject(state, state.thread)
	if s == nil then
		return empty("tmissing", "this subject is no longer in the messages read")
	end
	local messages = s.messages or {}
	local hidden = state.earlier and 0 or math.max(0, #messages - THREAD_TAIL)
	local kids = {}
	if hidden > 0 then
		table.insert(kids, button("earlier", string.format("Show %d earlier", hidden), "earlier", "quiet wide"))
	end
	for i = hidden + 1, #messages do
		local m = messages[i]
		local head = {
			ui.el("span", { key = "f", class = m.mine and "ag-from mine" or "ag-from", text = tostring(m.from) }),
		}
		if m.mine then
			table.insert(head, ui.el("span", { key = "you", class = "ag-tag accent", text = "you" }))
		end
		if m.kind == "human" and not m.mine then
			table.insert(head, ui.el("span", { key = "hum", class = "ag-tag", text = "human" }))
		end
		if m.seat == "member" then
			table.insert(head, ui.el("span", { key = "seat", class = "ag-tag", text = "member seat" }))
		end
		local when = tostring(m.age)
		if type(m.to) == "table" and #m.to > 0 then
			when = when .. " · to " .. table.concat(m.to, ", ")
		end
		table.insert(head, ui.el("span", { key = "a", class = "ag-caption", text = when }))
		local body = {}
		local derived = tostring(m.derived or "")
		-- the `to:` the header already shows; any other trailer (claim, verdict, …) is stated here
		if derived ~= "" and not string.match(derived, "^to ") then
			table.insert(body, ui.el("div", { key = "d", class = "ag-caption accent", text = derived }))
		end
		table.insert(body, ui.md(tostring(m.body or "")))
		if m.attachmentText and m.attachmentText ~= "" then
			table.insert(body, ui.el("div", { key = "att", class = "ag-caption mono", text = tostring(m.attachmentText) }))
		end
		table.insert(kids, ui.el("div", { key = "m_" .. m.id, class = m.mine and "ag-msg mine" or "ag-msg" }, {
			ui.el("div", { key = "h", class = "ag-msg-head" }, head),
			ui.el("div", { key = "b", class = "ag-msg-body" }, body),
		}))
	end
	local count = #messages
	return section("thread", tostring(s.fullTitle or s.title), string.format("%d %s · started by %s", count, count == 1 and "message" or "messages", tostring(s.rootFrom)), kids, "ag-title")
end

local function render_room(state: any): { Node }
	local out = {}
	if state.thread == nil then
		table.insert(out, render_presence(state))
	else
		table.insert(out, button("back", "← Subjects", "back", "quiet"))
	end
	table.insert(out, render_compose(state))
	if state.thread == nil then
		table.insert(out, render_subjects(state))
	else
		table.insert(out, render_thread(state))
	end
	return out
end

-- ---------------------------------------------------------------------------------------------
-- Tab 2: Search & horizon
-- ---------------------------------------------------------------------------------------------

local function all_messages(state: any): { any }
	local out = {}
	for _, s in ipairs(subjects_of(state)) do
		for _, m in ipairs(s.messages or {}) do
			table.insert(out, { subject = s, m = m })
		end
	end
	table.sort(out, function(a, b)
		return tostring(a.m.ts) > tostring(b.m.ts)
	end)
	return out
end

local function render_search(state: any): { Node }
	local view = state.view or {}
	local q = string.lower(state.search or "")
	local presets = { "", "verdict", "claim", "release", "to " }
	for i, w in ipairs((view.board and view.board.who) or {}) do
		if i > 4 then
			break
		end
		table.insert(presets, tostring(w.authorName or w.speaker))
	end
	local chips = {}
	for i, p in ipairs(presets) do
		table.insert(chips, chip("q" .. tostring(i), p == "" and "everything loaded" or p, "q=" .. p, (state.search or "") == p))
	end
	local rows, acts = {}, {}
	local total = 0
	for _, hit in ipairs(all_messages(state)) do
		local m = hit.m
		local hay = string.lower(tostring(m.body or "") .. "\n" .. tostring(m.from or "") .. "\n" .. tostring(m.derived or ""))
		if q == "" or string.find(hay, q, 1, true) then
			total += 1
			if #rows < SEARCH_LIMIT then
				local preview = string.gsub(tostring(m.body or ""), "%s+", " ")
				table.insert(rows, {
					ui.span(short_ts(m.ts), "muted"),
					ui.span(tostring(m.from or "") .. ((m.kind == "human") and " (human)" or ""), m.kind == "human" and "accent" or "strong"),
					ui.span(tostring(m.derived ~= "" and m.derived or (hit.subject.id ~= m.id and ("in " .. string.sub(tostring(hit.subject.title), 1, 40)) or "subject")), "muted"),
					ui.span(string.sub(preview, 1, 160)),
					ui.span(cursor_tail(m.cursor), "muted"),
				})
				acts[#rows] = "jump=" .. tostring(m.id)
			end
		end
	end
	local h = view.horizon or {}
	local horizon = string.format(
		"%s · oldest loaded %s (cursor %s) · read to %s · read %s · %s · older messages are not searched",
		tostring(view.room or ""),
		tostring((h.oldestTs and h.oldestTs ~= "") and h.oldestTs or "nothing"),
		tostring((h.oldestCursor and h.oldestCursor ~= "") and h.oldestCursor or "-"),
		tostring((h.readTo and h.readTo ~= "") and h.readTo or "-"),
		tostring(h.readAt or ""),
		tostring(h.source or "")
	)
	return {
		ui.el("div", { key = "search", class = "ag-card" }, {
			ui.el("div", { key = "f", class = "ag-field" }, {
				ui.el("span", { key = "l", class = "ag-field-label", text = "find" }),
				ui.node("input", {
					key = "input",
					text = state.search or "",
					cursor = #(state.search or ""),
					placeholder = state.search_typing and "type: text, author or trailer · Enter or Esc done" or "press / to type",
					prompt = "⌕ ",
				}),
			}),
			ui.el("div", { key = "presets", class = "ag-chips" }, chips),
		}),
		section("hits", string.format("Messages · %d match%s", total, total == 1 and "" or "es"), total > SEARCH_LIMIT and string.format("the newest %d shown · click one to open its thread", SEARCH_LIMIT) or "click one to open its thread", {
			#rows > 0 and data_table("hits_t", {
				{ head = "When" },
				{ head = "Who" },
				{ head = "Trailers / subject" },
				{ head = "Text" },
				{ head = "Cursor" },
			}, rows, acts) or empty("nohits", "nothing in the loaded messages matches"),
		}),
		ui.el("div", { key = "horizon", class = "ag-caption mono", text = horizon }),
	}
end

-- ---------------------------------------------------------------------------------------------
-- Tab 3: Board & who
-- ---------------------------------------------------------------------------------------------

local function render_board(state: any): { Node }
	local board = (state.view and state.view.board) or {}
	local claims, verdicts, who = board.claims or {}, board.verdicts or {}, board.who or {}
	local c_rows, c_acts = {}, {}
	for i, c in ipairs(claims) do
		table.insert(c_rows, {
			ui.span(tostring(c.status), c.status == "held" and "warn" or (c.status == "released" and "ok" or "muted")),
			ui.span(tostring(c.subject), "strong"),
			ui.span(tostring(c.holder)),
			ui.span(short_ts(c.ts), "muted"),
		})
		c_acts[i] = "jump=" .. tostring(c.messageId)
	end
	local v_rows, v_acts = {}, {}
	for i, v in ipairs(verdicts) do
		table.insert(v_rows, {
			ui.span(tostring(v.status), v.status == "standing" and "ok" or "muted"),
			ui.span(tostring(v.verdict), "strong"),
			ui.span(tostring(v.author)),
			ui.span(tostring(v.exhibit), "accent"),
			ui.span(tostring(v.because), "muted"),
		})
		v_acts[i] = "jump=" .. tostring(v.messageId)
	end
	local w_rows = {}
	for _, w in ipairs(who) do
		table.insert(w_rows, {
			ui.span(tostring(w.speaker), "strong"),
			ui.span(tostring(w.kind), w.kind == "human" and "accent" or "muted"),
			ui.span(tostring(w.count)),
			ui.span(short_ts(w.lastTs), "muted"),
			ui.span((w.origin and w.origin ~= "") and tostring(w.origin) or "not known", "muted"),
			ui.span(w.watching and "● watching" or "", w.watching and "ok" or "muted"),
		})
	end
	return {
		section("claims", "Claims · " .. tostring(#claims), "from claim / release trailers in the messages read · click to open", {
			#c_rows > 0 and data_table("claims_t", { { head = "State" }, { head = "Subject" }, { head = "Holder" }, { head = "When" } }, c_rows, c_acts) or empty("noclaims", "no claim or release trailers"),
		}),
		section("verdicts", "Verdicts · " .. tostring(#verdicts), "from verdict / exhibit / because trailers · click to open", {
			#v_rows > 0 and data_table("verdicts_t", { { head = "Status" }, { head = "Verdict" }, { head = "By" }, { head = "Exhibit" }, { head = "Because" } }, v_rows, v_acts) or empty("noverdicts", "no verdict trailers"),
		}),
		section("who", "Who spoke · " .. tostring(#who), "from the messages read, not presence; 'watching' counts only watches armed from this seat", {
			#w_rows > 0 and data_table("who_t", { { head = "Speaker" }, { head = "Kind" }, { head = "Messages", align = "end" }, { head = "Last" }, { head = "Account on" }, { head = "Watching" } }, w_rows) or empty("nowho", "nobody"),
		}),
	}
end

-- ---------------------------------------------------------------------------------------------
-- Tab 4: Rooms & faces
-- ---------------------------------------------------------------------------------------------

local function render_rooms(state: any): { Node }
	local rooms = (state.view and state.view.rooms) or {}
	local rows, acts = {}, {}
	local out = {}
	for i, r in ipairs(rooms) do
		local cur = r.alias == state.room
		table.insert(rows, {
			ui.span((cur and "▸ " or "") .. tostring(r.alias), cur and "strong" or nil),
			ui.span(tostring(r.transport), r.transport == "native" and "accent" or "muted"),
			ui.span(tostring(r.target), "muted"),
			ui.span(tostring(r.tokenKind), "muted"),
			ui.span(tostring(r.note or ""), "muted"),
		})
		acts[i] = "room=" .. tostring(r.alias)
	end
	table.insert(out, section("rooms", "Rooms · " .. tostring(#rooms), "the agora config's rooms the pane offers · click to switch", {
		data_table("rooms_t", { { head = "Alias" }, { head = "Transport" }, { head = "Room / channel / path" }, { head = "Credential" }, { head = "Note" } }, rows, acts),
	}))
	for _, r in ipairs(rooms) do
		local nm = r.nativeMeta
		if type(nm) == "table" then
			local f_rows = {}
			for _, f in ipairs(nm.faces or {}) do
				table.insert(f_rows, {
					ui.span(f.enabled and "● on" or "○ off", f.enabled and "ok" or "muted"),
					ui.span(tostring(f.transport) .. " → " .. tostring(f.alias), "strong"),
					ui.span(tostring(f.target), "muted"),
					ui.span("human " .. tostring(f.human) .. " · agent " .. tostring(f.agent)),
					ui.span(tostring(f.attachments), "muted"),
				})
			end
			table.insert(out, section("native_" .. tostring(r.alias), tostring(r.alias) .. " · native store", string.format("epoch %s · sequence %d · %s…", tostring(nm.epoch), tonumber(nm.sequence) or 0, tostring(nm.digest)), {
				#f_rows > 0 and data_table("faces_" .. tostring(r.alias), { { head = "Face" }, { head = "Transport → alias" }, { head = "Target" }, { head = "Crosses" }, { head = "Attachments" } }, f_rows) or empty("nofaces_" .. tostring(r.alias), "no outbound faces"),
			}))
		end
	end
	return out
end

-- ---------------------------------------------------------------------------------------------
-- Tab 5: Peers, service & residents
-- ---------------------------------------------------------------------------------------------

local function render_peers(state: any): { Node }
	local view = state.view or {}
	local svc = view.service or {}
	local human = view.human or {}
	local sess = view.sessions or {}
	local counts = sess.counts or {}
	local function act(verb: string, label: string, class: string?): Node
		return button("act_" .. verb, state.busy == verb and (label .. "…") or label, "seat=" .. verb, class)
	end
	local out = {
		ui.el("div", { key = "acts", class = "ag-row wrap" }, {
			act("service-start", "Start the seat service", "primary"),
			act("service-stop", "Stop the seat service", "warn"),
			act("resident-cycle-dry", "Resident cycle (dry run)"),
			act("prune-sessions-dry", "Prune sessions (dry run)"),
		}),
	}
	if state.seat_output then
		table.insert(out, section("output", "agora " .. tostring(SEAT_LABELS[state.seat_output.verb] or state.seat_output.verb), state.seat_output.ok and "done" or "failed", {
			ui.code(state.seat_output.text ~= "" and state.seat_output.text or "(no output)", "json"),
		}))
	end
	table.insert(out, section("service", "Seat service", nil, {
		ui.kv({
			{ ui.span("service", "muted"), svc.pidAlive and ui.span(string.format("● running · pid %d · seat %s · build %s · since %s", tonumber(svc.pid) or 0, tostring(svc.seatLabel), tostring(svc.build), tostring(svc.startedAt)), "ok") or ui.span(svc.present and string.format("▲ stopped (last pid %d, seat %s)", tonumber(svc.pid) or 0, tostring(svc.seatLabel)) or "▲ no service on this seat", "bad") },
			{ ui.span("this seat's human", "muted"), ui.span(human.name ~= "" and (tostring(human.name) .. " (native/human.json)") or "no name yet", human.name ~= "" and "strong" or "warn") },
			{ ui.span("posts from this pane", "muted"), ui.span(tostring((view.posting and view.posting.detail) or ""), "muted") },
		}),
		button("name2", "Set your name", "name", "quiet"),
	}))
	local r_rows = {}
	for _, r in ipairs(view.residents or {}) do
		table.insert(r_rows, {
			ui.span(tostring(r.slug), "strong"),
			ui.span(r.state == "live" and "● live" or "○ idle", r.state == "live" and "ok" or "muted"),
			ui.span(tostring(r.bearer or "")),
			ui.span(tostring(r.label or ""), "muted"),
			ui.span(short_ts(r.lastSeen), "muted"),
			ui.span(r.restart ~= "" and "restart set" or "", "muted"),
		})
	end
	table.insert(out, section("residents", "Residents · " .. tostring(#(view.residents or {})), "the config's residents table, each with the live sessions that hold it", {
		#r_rows > 0 and data_table("res_t", { { head = "Resident" }, { head = "State" }, { head = "Bearer" }, { head = "Position" }, { head = "Last seen" }, { head = "Restart" } }, r_rows) or empty("nores", "no residents table in the agora config"),
	}))
	local p_rows = {}
	for _, p in ipairs(sess.items or {}) do
		local armed = {}
		for _, a in ipairs(p.armed or {}) do
			table.insert(armed, string.format("%s (%s, pid %s)", tostring(a.key), tostring(a.mode), tostring(a.pid)))
		end
		local rooms = (type(p.rooms) == "table" and #p.rooms > 0) and table.concat(p.rooms, ", ") or "—"
		if (tonumber(p.threadCount) or 0) > 0 then
			rooms = rooms .. string.format(" +%d threads", tonumber(p.threadCount) or 0)
		end
		table.insert(p_rows, {
			ui.span(p.state == "live" and "● live" or (p.state == "dark" and "◐ dark" or "○ unknown"), p.state == "live" and "ok" or (p.state == "dark" and "muted" or "warn")),
			ui.span(tostring(p.bearer), "strong"),
			ui.span(tostring(p.label or ""), "muted"),
			ui.span((tonumber(p.pid) or 0) > 0 and tostring(p.pid) or "—", "muted"),
			ui.span(short_ts(p.lastSeen), "muted"),
			ui.span(rooms),
			ui.span(#armed > 0 and table.concat(armed, ", ") or "—", #armed > 0 and "accent" or "muted"),
		})
	end
	table.insert(out, section("sessions", string.format("Sessions on this seat · %d live · %d unknown · %d dark · %d watches", tonumber(counts.live) or 0, tonumber(counts.unknown) or 0, tonumber(counts.dark) or 0, tonumber(counts.armed) or 0), "other seats' sessions are not visible from here", {
		#p_rows > 0 and data_table("sess_t", { { head = "State" }, { head = "Bearer" }, { head = "Position" }, { head = "PID", align = "end" }, { head = "Last seen" }, { head = "Rooms" }, { head = "Watches armed" } }, p_rows) or empty("nosess", "no sessions registered on this seat"),
	}))
	return out
end

-- ---------------------------------------------------------------------------------------------
-- The view
-- ---------------------------------------------------------------------------------------------

local function render_main(state: any): Node
	local kids = { render_header(state) }
	for _, n in ipairs(render_alerts(state)) do
		table.insert(kids, n)
	end
	if state.view == nil then
		table.insert(kids, ui.progress(nil, state.error and "the room could not be read" or "reading the room…"))
		return ui.col(kids)
	end
	local body
	if state.mode == "search" then
		body = render_search(state)
	elseif state.mode == "board" then
		body = render_board(state)
	elseif state.mode == "rooms" then
		body = render_rooms(state)
	elseif state.mode == "peers" then
		body = render_peers(state)
	else
		body = render_room(state)
	end
	for _, n in ipairs(body) do
		table.insert(kids, n)
	end
	return ui.col(kids)
end

local function keys(list: { { string } }): Node
	local spans = {}
	for i, k in ipairs(list) do
		if i > 1 then
			table.insert(spans, ui.span("   "))
		end
		table.insert(spans, ui.span(k[1], "key"))
		table.insert(spans, ui.span(" " .. k[2], "muted"))
	end
	return ui.text(spans)
end

local function render_dock(state: any): Node
	if state.typing then
		return ui.col({ keys({ { "Enter", "post" }, { "Shift+Enter", "new line" }, { "Esc", "stop writing" } }) })
	end
	if state.search_typing then
		return ui.col({ keys({ { "Enter", "done" }, { "Esc", "done" } }) })
	end
	if state.mode == "room" and state.thread ~= nil then
		return ui.col({ keys({ { "i", "write" }, { "b", "subjects" }, { "n", "new subject" }, { "e", "earlier" }, { "r", "refresh" }, { "1-5", "tabs" }, { "q", "close" } }) })
	elseif state.mode == "room" then
		return ui.col({ keys({ { "j k", "move" }, { "Enter", "open" }, { "i", "write" }, { "n", "new subject" }, { "w", "who" }, { "m", "more" }, { "/", "search" }, { "r", "refresh" }, { "1-5", "tabs" }, { "q", "close" } }) })
	end
	return ui.col({ keys({ { "1-5", "tabs" }, { "Tab", "next tab" }, { "/", "search" }, { "r", "refresh" }, { "q", "close" } }) })
end

-- ---------------------------------------------------------------------------------------------
-- Actions
-- ---------------------------------------------------------------------------------------------

local function switch_room(state: any, room: string, cx: BlockCx)
	if room == state.room then
		return
	end
	state.room = room
	state.view = nil
	state.thread = nil
	state.selected = nil
	state.limit = SUBJECTS_PAGE
	state.earlier = false
	state.error = nil
	state.flash = nil
	state.to = "auto"
	refresh(state, cx, false)
end

local function open_subject(state: any, id: string)
	local s = find_subject(state, id)
	if s == nil then
		return
	end
	state.mode = "room"
	state.thread = id
	state.selected = id
	state.earlier = false
	state.flash = nil
	state.to = "auto"
	mark_seen(state, s)
end

local function back_to_list(state: any)
	state.thread = nil
	state.earlier = false
	state.flash = nil
	state.to = "auto"
end

-- A message id from search or the board: the subject it belongs to is opened.
local function jump(state: any, id: string)
	for _, s in ipairs(subjects_of(state)) do
		for _, m in ipairs(s.messages or {}) do
			if m.id == id then
				open_subject(state, s.id)
				state.earlier = true
				return
			end
		end
	end
	state.flash = "that message is no longer in the messages read"
	state.flash_warn = true
end

local function move_selection(state: any, to: number?, delta: number?)
	local subjects = subjects_of(state)
	local limit = math.min(#subjects, state.limit)
	if limit == 0 then
		return
	end
	local idx = 0
	for i = 1, limit do
		if subjects[i].id == state.selected then
			idx = i
		end
	end
	if to ~= nil then
		idx = to
	else
		idx = (idx == 0) and 1 or (idx + (delta or 0))
	end
	idx = math.max(1, math.min(limit, idx))
	state.selected = subjects[idx].id
end

local function cycle_mode(state: any, delta: number)
	for i, m in ipairs(MODES) do
		if m == state.mode then
			state.mode = MODES[((i - 1 + delta) % #MODES) + 1]
			return
		end
	end
	state.mode = "room"
end

local function drop_last_char(s: string): string
	if #s == 0 then
		return s
	end
	local n = utf8.len(s)
	if n == nil or n == 0 then
		return string.sub(s, 1, #s - 1)
	end
	local at = utf8.offset(s, n)
	return string.sub(s, 1, (at or #s) - 1)
end

local function set_mode(state: any, mode: string)
	for _, m in ipairs(MODES) do
		if m == mode then
			state.mode = mode
			state.search_typing = (mode == "search")
			return
		end
	end
end

local function read_last_view(room: string?): any
	if not tern.fs.exists(LAST_VIEW) then
		return nil
	end
	local ok, raw = pcall(tern.fs.read, LAST_VIEW, 8000000)
	if not ok or not raw then
		return nil
	end
	local okd, v = pcall(tern.json.decode, raw)
	if okd and type(v) == "table" and v.ok and (room == nil or v.room == room) then
		return v
	end
	return nil
end

-- ---------------------------------------------------------------------------------------------
-- The block. Launch args: { room?, mode? } (mode: room, search, board, rooms, peers).
-- ---------------------------------------------------------------------------------------------

tern.block.define("room", {
	init = function(cx: BlockCx, args: { string }, saved: any)
		local room = (args and args[1] and args[1] ~= "" and args[1]) or (type(saved) == "table" and saved.room) or nil
		local mode = (args and args[2] and args[2] ~= "" and args[2]) or (type(saved) == "table" and saved.mode) or "room"
		if room == nil then
			local ok, last = pcall(tern.kv.get, "last_room")
			if ok and type(last) == "string" and last ~= "" then
				room = last
			end
		end
		local state = new_state(room, nil)
		set_mode(state, mode)
		state.search_typing = false
		-- the last read paints at once; the fresh one replaces it
		local last = read_last_view(room)
		if last then
			state.view = last
			state.room = last.room
		end
		refresh(state, cx, true)
		poll_start(state, cx)
		return state
	end,

	title = function(state: any): string
		local n = unread_subjects(state)
		return "Agora · " .. tostring(state.room or "room") .. (n > 0 and (" · " .. tostring(n) .. " new") or "")
	end,

	view = function(state: any, _cx: BlockCx): BlockView
		return { main = render_main(state), dock = render_dock(state) }
	end,

	event = function(state: any, ev: UiEvent, cx: BlockCx)
		if ev.ev ~= "action" then
			return
		end
		local act = tostring(ev.act or "")
		local val = tostring(ev.value or "")
		if act == "mode" then
			set_mode(state, val)
		elseif act == "room" and val ~= "" then
			switch_room(state, val, cx)
		elseif act == "open" and val ~= "" then
			open_subject(state, val)
		elseif act == "jump" and val ~= "" then
			jump(state, val)
		elseif act == "back" then
			back_to_list(state)
		elseif act == "new" then
			back_to_list(state)
			state.typing = true
		elseif act == "to" then
			state.to = val
		elseif act == "refresh" then
			state.flash = nil
			state.refresh_remote = true
			refresh(state, cx, false)
		elseif act == "who" then
			state.who_open = not state.who_open
		elseif act == "more" then
			state.limit += SUBJECTS_PAGE
		elseif act == "earlier" then
			state.earlier = true
		elseif act == "type" then
			state.mode = "room"
			state.typing = true
		elseif act == "done" then
			state.typing = false
		elseif act == "clear" then
			state.draft = ""
		elseif act == "post" then
			send(state, cx)
		elseif act == "q" then
			state.search = val
		elseif act == "seat" and val ~= "" then
			seat_action(state, val, cx)
		elseif act == "name" then
			-- the window half asks for the name (a block cannot prompt): see window.luau's link route
			cx:open("agora://name")
		elseif act == "close" then
			cx:exit(0)
			return
		end
		cx:render()
	end,

	key = function(state: any, k: Key, cx: BlockCx): boolean?
		if state.typing then
			if k.name == "escape" then
				state.typing = false
			elseif k.name == "enter" then
				if k.shift or k.alt then
					state.draft = state.draft .. "\n"
				else
					send(state, cx)
				end
			elseif k.name == "backspace" then
				state.draft = drop_last_char(state.draft)
			elseif k.name == "paste" and k.text ~= nil then
				state.draft = state.draft .. k.text
			elseif k.text ~= nil and k.text ~= "" and not k.ctrl and not k.alt and not k.meta then
				state.draft = state.draft .. k.text
			else
				return false
			end
			return true
		end
		if state.search_typing then
			if k.name == "escape" or k.name == "enter" then
				state.search_typing = false
			elseif k.name == "backspace" then
				state.search = drop_last_char(state.search)
			elseif k.name == "paste" and k.text ~= nil then
				state.search = state.search .. k.text
			elseif k.text ~= nil and k.text ~= "" and not k.ctrl and not k.alt and not k.meta then
				state.search = state.search .. k.text
			else
				return false
			end
			return true
		end
		local digit = tonumber(k.name)
		if digit ~= nil and digit >= 1 and digit <= #MODES and not k.ctrl and not k.alt then
			set_mode(state, MODES[digit])
		elseif k.name == "tab" or (k.ctrl and (k.name == "n" or k.name == "p")) then
			cycle_mode(state, (k.shift or (k.ctrl and k.name == "p")) and -1 or 1)
		elseif k.name == "f" then
			cycle_mode(state, k.shift and -1 or 1)
		elseif k.name == "/" then
			set_mode(state, "search")
		elseif k.name == "r" then
			state.flash = nil
			state.refresh_remote = true
			refresh(state, cx, false)
		elseif k.name == "q" then
			cx:exit(0)
			return false
		elseif state.mode ~= "room" then
			return false
		elseif k.name == "i" then
			state.typing = true
		elseif k.name == "n" then
			back_to_list(state)
			state.typing = true
		elseif k.name == "b" or k.name == "escape" then
			if state.thread == nil then
				return false
			end
			back_to_list(state)
		elseif k.name == "t" then
			if state.thread ~= nil then
				back_to_list(state)
			elseif (state.selected or (subjects_of(state)[1] and subjects_of(state)[1].id)) ~= nil then
				open_subject(state, state.selected or subjects_of(state)[1].id)
			else
				return false
			end
		elseif k.name == "enter" then
			local target = state.selected or (subjects_of(state)[1] and subjects_of(state)[1].id)
			if state.thread ~= nil or target == nil then
				return false
			end
			open_subject(state, target)
		elseif k.name == "e" and state.thread ~= nil then
			state.earlier = true
		elseif state.thread ~= nil then
			return false
		elseif k.name == "w" then
			state.who_open = not state.who_open
		elseif k.name == "m" then
			state.limit += SUBJECTS_PAGE
		elseif k.name == "j" or k.name == "down" then
			move_selection(state, nil, 1)
		elseif k.name == "k" or k.name == "up" then
			move_selection(state, nil, -1)
		elseif k.name == "home" or (k.name == "g" and not k.shift) then
			move_selection(state, 1, nil)
		elseif k.name == "end" or k.name == "G" or (k.name == "g" and k.shift) then
			move_selection(state, math.min(#subjects_of(state), state.limit), nil)
		else
			return false
		end
		return true
	end,

	save = function(state: any)
		return { room = state.room, mode = state.mode }
	end,
})

-- ---------------------------------------------------------------------------------------------
-- Lenses for agora's own commands: `agora rooms` / `agora who`, `agora doctor` / `agora service`,
-- `agora session`. Each reads the command's --json lines; without them the raw output shows.
-- ---------------------------------------------------------------------------------------------

local function lens_open(_run: LensRun, _cx: EffectCx): any
	return { lines = {}, status = nil }
end

local function lens_line(state: any, l: LensLine)
	table.insert(state.lines, l.text)
end

local function lens_finish(state: any, status: number)
	state.status = status
end

local function json_lines(state: any): { any }
	local out = {}
	for _, ln in ipairs(state.lines) do
		if string.sub(ln, 1, 1) == "{" then
			local ok, r = pcall(tern.json.decode, ln)
			if ok and type(r) == "table" then
				table.insert(out, r)
			end
		end
	end
	return out
end

tern.lens.define("rooms", {
	open = lens_open,
	line = lens_line,
	finish = lens_finish,
	view = function(state: any): Node?
		if state.status ~= 0 then
			return nil
		end
		local rows = {}
		for _, r in ipairs(json_lines(state)) do
			if r.alias then
				table.insert(rows, { ui.span(tostring(r.alias), "strong"), ui.span(tostring(r.transport or ""), "accent"), ui.span(tostring(r.room or ""), "muted"), ui.span(tostring(r.note or ""), "muted") })
			end
		end
		if #rows == 0 then
			return nil
		end
		return ui.card(ui.span("Agora rooms · " .. tostring(#rows), "strong"), {
			ui.table({ { id = "alias", head = "Alias", priority = 4 }, { id = "trans", head = "Transport", priority = 4 }, { id = "room", head = "Target", grow = 1, priority = 3 }, { id = "note", head = "Note", grow = 2, priority = 2 } }, rows),
		})
	end,
})

tern.lens.define("doctor", {
	open = lens_open,
	line = lens_line,
	finish = lens_finish,
	view = function(state: any): Node?
		if state.status == nil then
			return nil
		end
		local items = {}
		for _, r in ipairs(json_lines(state)) do
			if r.type == "service" or r.type == "native-service" then
				table.insert(items, { ui.span("seat service", "muted"), ui.span((r.pidAlive and "● running" or "▲ stopped") .. " · pid " .. tostring(r.pid or 0) .. " · seat " .. tostring(r.seatLabel or ""), r.pidAlive and "ok" or "bad") })
			elseif r.type == "identity" then
				table.insert(items, { ui.span("bearer", "muted"), ui.span(tostring(r.bearer or "") .. " (session " .. tostring(r.session or "") .. ")", "strong") })
			elseif r.type == "warning" then
				table.insert(items, { ui.span("▲ " .. tostring(r.code or "warning"), "warn"), ui.span(tostring(r.message or ""), "warn") })
			end
		end
		if #items == 0 then
			return nil
		end
		return ui.card(ui.span("Agora doctor", "strong"), { ui.kv(items) })
	end,
})

tern.lens.define("session", {
	open = lens_open,
	line = lens_line,
	finish = lens_finish,
	view = function(state: any): Node?
		if state.status ~= 0 then
			return nil
		end
		local rows = {}
		for _, r in ipairs(json_lines(state)) do
			if r.type == "session" and #rows < 40 then
				table.insert(rows, { ui.span(tostring(r.state or ""), r.state == "live" and "ok" or "muted"), ui.span(tostring(r.bearer or "(unregistered)"), "strong"), ui.span(tostring(r.label or ""), "muted"), ui.span(tostring(r.pid or "—"), "muted"), ui.span(string.sub(tostring(r.lastSeen or ""), 1, 16), "muted"), ui.span(tostring(r.slug or ""), "muted") })
			end
		end
		if #rows == 0 then
			return nil
		end
		return ui.card(ui.span("Agora sessions · " .. tostring(#rows), "strong"), {
			ui.table({ { id = "st", head = "State", priority = 4 }, { id = "bearer", head = "Bearer", priority = 4 }, { id = "label", head = "Position", priority = 3 }, { id = "pid", head = "PID", align = "end", priority = 2 }, { id = "seen", head = "Last seen", priority = 3 }, { id = "slug", head = "Session", grow = 1, priority = 2 } }, rows),
		})
	end,
})
