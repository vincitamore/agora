-- window.luau: where the Agora pane sits in a Tern window.
--   * palette commands: open (ctrl+alt+a), switch room, post as yourself, float as a picture, set your name
--   * one status-line segment: the room and how many of its subjects have something new
--   * `agora://` links: `agora://room/<alias>[/<mode>]` opens the pane there, `agora://name` asks
--     for this seat's human's name (the block's "Set your name" button goes through it)
--   * a Carly export, `open_agora(room?, mode?)`, and one line of context
-- The block (reading, drawing, posting) is host.luau's; this half places it and asks the person.

local KIND = "agora.room"
local BRIDGE = tern.plugin.dir .. "/bridge.mjs"
local DATA = tern.plugin.data
local NODE = tern.getenv("AGORA_TERN_NODE") or "node"
local MODES = { room = true, search = true, board = true, rooms = true, peers = true }

-- Runs `node bridge.mjs <args> --data <data folder>` and calls `cb` with the decoded object and the
-- fresh window cx a process callback is handed (nil when the process could not start).
local function bridge(args: { string }, input: any, cb: (any, WindowCx?) -> ())
	local argv = { NODE, BRIDGE }
	for _, a in ipairs(args) do
		table.insert(argv, a)
	end
	table.insert(argv, "--data")
	table.insert(argv, DATA)
	local opts: any = { timeout_ms = 30000 }
	if input ~= nil then
		opts.stdin = tern.json.encode(input)
	end
	local started = pcall(tern.process.run, argv, opts, function(res, cx: WindowCx?)
		local ok, decoded = pcall(tern.json.decode, res.stdout or "")
		if res.status == 0 and ok and type(decoded) == "table" then
			cb(decoded, cx)
		else
			cb({ ok = false, error = string.match(res.stderr or "", "([^\r\n]+)%s*$") or ("exit " .. tostring(res.status)) }, cx)
		end
	end)
	if not started then
		cb({ ok = false, error = "could not start `" .. NODE .. "` (set AGORA_TERN_NODE)" }, nil)
	end
end

-- A window shows one Agora pane: opening it again focuses that one, on the room and tab asked for.
local function open_or_focus(cx: WindowCx, room: string?, mode: string?, how: How?): number?
	local r = (room and room ~= "") and room or ""
	local m = (mode and MODES[mode]) and mode or ""
	for _, p in ipairs(cx.session:panes()) do
		if p.block == KIND and not p.parked then
			cx.layout:focus(p.pane)
			if r ~= "" then
				pcall(function()
					cx.session:event(p.pane, { ev = "action", act = "room", value = r })
				end)
			end
			if m ~= "" then
				pcall(function()
					cx.session:event(p.pane, { ev = "action", act = "mode", value = m })
				end)
			end
			return p.pane
		end
	end
	return cx:new_block(KIND, { r, m }, how or "beside")
end

local function ask_name(cx: WindowCx)
	cx:prompt({ placeholder = "Your name, as it signs your posts from this seat", icon = "users", action = "set name" }):next(function(name, _err, inner)
		if not name or name == "" or not inner then
			return
		end
		bridge({ "set-name" }, { name = name }, function(res, tcx)
			if not tcx then
				return
			end
			if res.ok then
				tcx:toast("success", "Posts from the Agora pane now sign as " .. tostring(res.human and res.human.name or name))
			else
				tcx:toast("error", "Name not set", tostring(res.error or ""))
			end
		end)
	end)
end

-- ---------------------------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------------------------

tern.command({
	id = "open",
	title = "Agora: open the room pane",
	icon = "users",
	group = "Agora",
	keys = { "ctrl+alt+a" },
	run = function(cx: WindowCx)
		open_or_focus(cx, nil, nil, "beside")
	end,
})

tern.command({
	id = "switch_room",
	title = "Agora: open a room…",
	icon = "users",
	group = "Agora",
	run = function(_cx: WindowCx)
		bridge({ "rooms" }, nil, function(res, tcx)
			if not tcx then
				return
			end
			if not res.ok or type(res.rooms) ~= "table" or #res.rooms == 0 then
				tcx:toast("error", "No rooms to open", tostring(res.error or "the agora config has no rooms"))
				return
			end
			local items: { PickItem } = {}
			for _, r in ipairs(res.rooms) do
				table.insert(items, {
					label = tostring(r.alias),
					detail = (r.note and r.note ~= "") and tostring(r.note) or tostring(r.target or ""),
					group = tostring(r.transport),
					icon = "users",
					current = r.alias == tern.kv.get("last_room"),
					alias = tostring(r.alias),
				})
			end
			tcx:pick({ items = items, placeholder = "Open an Agora room…", icon = "users", action = "open" }):next(function(chosen, _err, inner)
				if chosen and chosen.alias and inner then
					open_or_focus(inner, tostring(chosen.alias), "room", "beside")
				end
			end)
		end)
	end,
})

tern.command({
	id = "post",
	title = "Agora: post to a room…",
	icon = "send",
	group = "Agora",
	run = function(cx: WindowCx)
		local last = tern.kv.get("last_room")
		local room = (type(last) == "string" and last ~= "") and last or nil
		cx:prompt({
			placeholder = room and ("Post a new subject to " .. room .. " (or start with '<room>: ')") or "<room>: your message",
			icon = "send",
			action = "post",
		}):next(function(raw, _err, inner)
			if not raw or raw == "" or not inner then
				return
			end
			local target, body = room, raw
			local r, b = string.match(raw, "^([%w][%w._-]*):%s+(.+)$")
			if r and b then
				target, body = r, b
			end
			if not target then
				inner:toast("error", "Name the room: '<room>: your message'")
				return
			end
			bridge({ "post", "--room", target }, { text = body }, function(res, tcx)
				if not tcx then
					return
				end
				if res.ok then
					tcx:toast("success", "Posted to " .. tostring(target))
					for _, p in ipairs(tcx.session:panes()) do
						if p.block == KIND then
							pcall(function()
								tcx.session:event(p.pane, { ev = "action", act = "refresh" })
							end)
						end
					end
				else
					tcx:toast("error", "Not posted", tostring(res.error or ""))
				end
			end)
		end)
	end,
})

tern.command({
	id = "float",
	title = "Agora: float the room pane in a corner",
	icon = "users",
	group = "Agora",
	run = function(cx: WindowCx)
		local pane = open_or_focus(cx, nil, nil, "beside")
		if pane then
			cx.layout:float(pane, nil, "br")
		end
	end,
})

tern.command({
	id = "set_name",
	title = "Agora: set your name",
	icon = "users",
	group = "Agora",
	run = ask_name,
})

-- ---------------------------------------------------------------------------------------------
-- agora:// links
-- ---------------------------------------------------------------------------------------------

tern.route.link(function(req: LinkRequest, cx: WindowCx): RouteDecision?
	local rest = string.match(req.url, "^agora://(.*)$")
	if rest == nil then
		return nil
	end
	if rest == "name" then
		ask_name(cx)
		return { handled = true }
	end
	local room, mode = string.match(rest, "^room/([^/?#]*)/?([%a]*)")
	open_or_focus(cx, room, mode, req.mods.shift and "tab" or "beside")
	return { handled = true }
end)

-- ---------------------------------------------------------------------------------------------
-- A closed Agora pane is recorded in kv `closed` so its block's refresh chain ends (a block has
-- no close hook of its own). Only panes this window saw as Agora panes are recorded.
-- ---------------------------------------------------------------------------------------------

local agora_panes: { [number]: boolean } = {}

local function note_pane(cx: WindowCx, pane: number)
	local ok, info = pcall(function()
		return cx.session:pane(pane)
	end)
	if ok and info and info.block == KIND then
		agora_panes[pane] = true
	end
end

tern.on("pane_created", function(ev: PaneEvent, cx: WindowCx)
	note_pane(cx, ev.pane)
end)

tern.on("pane_closed", function(ev: PaneEvent, _cx: WindowCx)
	if not agora_panes[ev.pane] then
		return
	end
	agora_panes[ev.pane] = nil
	local ok, v = pcall(tern.kv.get, "closed")
	local closed = (ok and type(v) == "table") and v or {}
	closed[tostring(ev.pane)] = true
	pcall(tern.kv.set, "closed", closed)
end)

-- ---------------------------------------------------------------------------------------------
-- The status line: the room and its subjects with something new, from what the block last read
-- ---------------------------------------------------------------------------------------------

local status: any = nil

local function read_status(): boolean
	local ok, v = pcall(tern.kv.get, "status")
	local nv = (ok and type(v) == "table") and v or nil
	local changed = (nv == nil) ~= (status == nil) or (nv ~= nil and status ~= nil and (nv.room ~= status.room or nv.new ~= status.new))
	status = nv
	return changed
end

tern.chrome.status(function(_pane: StatusPaneInfo): { StatusSegment }?
	if status == nil or not status.room then
		return { { text = "Agora", icon = "users", tone = "muted", command = "plugin.agora.open" } }
	end
	local n = tonumber(status.new) or 0
	return {
		{
			text = n > 0 and string.format("%s · %d new", tostring(status.room), n) or tostring(status.room),
			icon = "users",
			tone = n > 0 and "warn" or "muted",
			command = "plugin.agora.open",
		},
	}
end)

local ticking = false
local function tick()
	if read_status() then
		pcall(tern.chrome.refresh)
	end
	tern.timer(15000, function()
		tick()
	end)
end

tern.on("window_start", function(cx: WindowCx)
	for _, p in ipairs(cx.session:panes()) do
		if p.block == KIND then
			agora_panes[p.pane] = true
		end
	end
	if not ticking then
		ticking = true
		tick()
	end
end)

-- ---------------------------------------------------------------------------------------------
-- Carly
-- ---------------------------------------------------------------------------------------------

tern.carly.context(function(_cx: WindowCx): string?
	if status == nil or not status.room then
		return nil
	end
	return string.format("Agora pane: room %s, %d subject(s) with new messages (plugins.agora.open_agora opens it).", tostring(status.room), tonumber(status.new) or 0)
end)

tern.carly.export(
	"open_agora",
	{
		sig = "(room: string?, mode: string?) -> number?",
		doc = "Opens or focuses the Agora pane (block agora.room) on a configured room and tab (room, search, board, rooms, peers); returns its pane id.",
	},
	function(room: any, mode: any, cx: WindowCx, call: ExportCall)
		local r = (type(room) == "string" and room ~= "") and room or nil
		local m = (type(mode) == "string" and mode ~= "") and mode or nil
		call:reply(open_or_focus(cx, r, m, "beside"))
	end
)
