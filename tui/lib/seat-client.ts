/**
 * SeatRoomClient: one client for the whole config, routing each alias to the client its room's
 * transport names. `local` rooms go to `LocalRoomClient` (the fixture-backed fallback and the
 * first slice's reader); `native` rooms go to `NativeRoomClient` (the seat service). The choice
 * is the config's, per room; there is no flag.
 */

import { LocalRoomClient, type RoomsView } from "./local-client";
import { NativeRoomClient, type NativeClientOptions } from "./native-client";
import type { HumanActor, PeerRow, PostResult, ReadResult, RoomClient, RoomInfo, SearchResult, SubscribeHandlers, Subscription } from "./room-client";

export class SeatRoomClient implements RoomClient {
  readonly kind = "seat";
  readonly local: LocalRoomClient;
  readonly native: NativeRoomClient;
  private readonly view: RoomsView;

  constructor(human: HumanActor, view: RoomsView, opts: { now?: () => Date; native?: NativeClientOptions } = {}) {
    this.view = view;
    this.local = new LocalRoomClient(human, view, { now: opts.now });
    this.native = new NativeRoomClient(human, view, { now: opts.now, ...(opts.native ?? {}) });
  }

  actor(): HumanActor {
    return this.local.actor();
  }

  adopt(actor: HumanActor): void {
    this.local.adopt(actor);
    this.native.adopt(actor);
  }

  get stateRoot(): string {
    return this.view.stateRoot;
  }

  /** Which client an alias belongs to, by the transport its config names. */
  clientFor(alias: string): RoomClient {
    if (this.view.native.some((r) => r.alias === alias)) return this.native;
    return this.local;
  }

  async rooms(): Promise<RoomInfo[]> {
    return [
      ...this.view.rooms.map(({ alias, transport, room, note }) => ({ alias, transport, room, note })),
      ...this.view.native.map(({ alias, transport, room, roomId, note }) => ({ alias, transport, room, roomId, note })),
      ...this.view.elsewhere,
    ];
  }

  read(alias: string, opts?: { since?: string; limit?: number }): Promise<ReadResult> {
    return this.clientFor(alias).read(alias, opts);
  }

  post(alias: string, text: string, opts?: { thread?: string }): Promise<PostResult> {
    return this.clientFor(alias).post(alias, text, opts);
  }

  peers(): Promise<PeerRow[]> {
    return this.local.peers();
  }

  /** A subscription for a native alias; nothing for a local one, which stays polled. */
  async subscribe(alias: string, since: string, handlers: SubscribeHandlers): Promise<Subscription | undefined> {
    const c = this.clientFor(alias);
    return c.subscribe ? c.subscribe(alias, since, handlers) : undefined;
  }

  /** The service's search for a native alias; nothing for a local one, searched in memory. */
  async search(alias: string, query: string, opts?: { limit?: number }): Promise<SearchResult | undefined> {
    const c = this.clientFor(alias);
    return c.search ? c.search(alias, query, opts) : undefined;
  }

  draftRefusal(text: string): string | undefined {
    return this.native.draftRefusal(text);
  }

  close(): void {
    this.native.close();
  }
}
