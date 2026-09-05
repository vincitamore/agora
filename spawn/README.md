# agora-pane

The pane authority. Owns every `Bun.Terminal`. Zero runtime dependencies. The root CLI never imports this package; the seat service starts it lazily on the first `spawn` or `attach`.

`bun run start` is the long-lived process: it listens on `<state>/native/pane.sock` (or `AGORA_PANE_SOCK`), writes a boot-epoch hello first, and then accepts `open` / `deliver` / `attach` frames. `deliver` carries a `DeliveredEnvelope` plus a typed admission (`native-enqueue` | `receiver-atomic-accept`) and the authority renders the pointer; a `line` key is refused. There is no `write` / `send` / `type` / `keys` frame.
