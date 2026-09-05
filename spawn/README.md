# agora-pane

The pane authority. Owns every `Bun.Terminal`. Zero runtime dependencies. The root CLI never imports this package; the seat service starts it lazily on the first `spawn` or `attach`.

Speech is over `<state>/native/pane.sock`. The write surface is `deliver` and `attach`. There is no `write` / `send` / `type` / `keys` frame.
