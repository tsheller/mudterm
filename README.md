# MUDTERM.IO

Modern browser-based MUD client. PWA. [www.mudterm.com](https://www.mudterm.com)

## Connections

- Direct WebSocket and bridge/proxy (Telnet over WebSocket) connection types
- Per-connection profiles for separate automation and auto-login per character
- Connection config synced to cloud when logged in
- Multiple connections open simultaneously via tab bar
- Auto-reconnect on disconnect

## Protocols

- gmcp.mudstandards.org — GMCP structured data over WebSocket
- terminal.mudstandards.org — raw terminal over WebSocket
- telnet.mudstandards.org — Telnet negotiation over WebSocket
- extended.mudstandards.org — extended protocol
- Auto-negotiation mode tries GMCP, extended, Telnet, terminal in order

## Automation

- Aliases — pattern-matched command expansion per profile
- Triggers — pattern-matched actions on incoming text per profile
- Timers — interval-based command execution per profile
- Scripts — per-profile scripting
- Automation package import/export
- Automation panel UI with live editing

## Terminal

- xterm.js renderer
- ANSI color and formatting
- Per-connection font family, font size, line height, letter spacing
- Configurable scrollback buffer
- Local echo toggle per connection
- Command history with configurable size
- Command separator for multi-command input

## Widgets (in progress)

- Widget grid with dockable zones
- Button grid widgets
- Widget registry for custom widget types

## UI

- Multi-session tab bar
- Status bar with connection state
- Log panel for session activity
- Automation panel
- Dark, light, and themed color schemes

## Cloud and Auth

- OAuth login via Google, GitHub, Discord
- Cloud sync for connections and profiles across devices
- Offline support via service worker

## PWA

- Installable on desktop and mobile
- Service worker for offline use
- Web app manifest

## Known Issues

- MCCP2 compression not working
- Echo foreground and background color settings exist in the UI but are not implemented
- MXP is stubbed, not implemented
