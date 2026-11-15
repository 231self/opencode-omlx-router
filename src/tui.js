import { buildStatus, formatStatus } from "./status.js"

/**
 * OpenCode TUI part. Plain object export, no JSX, no TypeScript.
 *
 * Status and settings live here rather than in a server command because
 * `ctx.session.synthetic` starts a model turn (see docs/development.md).
 */
export default {
  id: "omlx.router.tui",

  setup(context) {
    const showStatus = async () => {
      const status = buildStatus({ host: "opencode" })
      const message = formatStatus(status)
      if (context.ui?.dialog?.alert) {
        await context.ui.dialog.alert({ title: "oMLX Router", message })
      } else {
        await context.ui.toast.show({ title: "oMLX Router", message })
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "omlx.router.settings",
          title: "oMLX Router: settings",
          group: "oMLX Router",
          palette: true,
          slash: { name: "router", arguments: true },
          run: showStatus,
        },
      ],
      bindings: ["omlx.router.settings"],
    }))
  },
}
