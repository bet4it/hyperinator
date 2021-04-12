const fs = require('fs')
const yaml = require('js-yaml')
const untildify = require('untildify')

let hyperinator

function findBySession(termGroupState, sessionUid) {
  const {termGroups} = termGroupState
  return Object.keys(termGroups)
    .map(uid => termGroups[uid])
    .find(group => group.sessionUid === sessionUid)
}

// Generate Command queue from converted layout tree
function generateQueue(converted, initial) {
  let q = []

  if (Array.isArray(converted.cells)) {
    for (const [i, cell] of converted.cells.entries()) {
      if (i > 0) {
        q.push({
          action: 'split',
          mode: converted.type,
          index: cell.id
        })
      } else {
        q.push({
          action: 'jump',
          index: cell.id
        })
      }
      if (initial || i > 0) {
        q.push({
          action: 'cmd',
          index: cell.id
        })
      }
    }
    for (const cell of converted.cells) {
      q = q.concat(generateQueue(cell))
    }
  }
  return q
}

// Hyperinator instance
class Hyperinator {
  constructor(config, store) {
    this.store = store
    this.panes = []
    this.queue = []
    this.paneNum = 0
    this.lastIndex = 0
    this.knownUids = []

    let gStartDir
    let gShell
    let gShellArgs
    let gFocusIndex

    if (config.start_directory) {
      gStartDir = untildify(config.start_directory)
    }

    const gOptions = config.global_options
    if (gOptions) {
      for (const opt of Object.keys(gOptions)) {
        if (opt === 'default-shell') {
          gShell = gOptions[opt]
        }
        if (opt === 'default-shell-args') {
          gShellArgs = gOptions[opt]
          if (!Array.isArray(gShellArgs)) {
            gShellArgs = [gShellArgs]
          }
        }
      }
    }
    for (const [idx, win] of config.windows.entries()) {
      const i = win.panes.findIndex(cmd => cmd && cmd.reuse)
      if (i >= 0) {
        const temporaryPane = config.windows[0].panes[0]
        config.windows[0].panes[0] = win.panes[i]
        win.panes[i] = temporaryPane
        this.reuseIndex = i
        for (const win of config.windows.slice(0, idx)) {
          this.reuseIndex += win.panes.length
        }
        break
      }
    }

    for (const win of config.windows) {
      let focusIndex
      let startDir = gStartDir
      if (win.start_directory) {
        startDir = untildify(win.start_directory)
      }
      for (const cmd of win.panes) {
        const args = {shell: gShell, shellArgs: gShellArgs}
        let cwd = startDir
        const index = this.panes.length
        if (cmd) {
          if (cmd.start_directory) {
            cwd = untildify(cmd.start_directory)
          }
          if (cmd.focus) {
            focusIndex = index
          }
        }
        if (cwd) {
          args.cwd = cwd
        }
        this.panes.push({index, args, cmd})
      }
      if (win.focus) {
        gFocusIndex = typeof focusIndex === 'undefined' ? this.panes.length - 1 : focusIndex
      }

      const layoutPtr = {s: win.layout.slice(5)}
      const layoutTree = this.layoutConstruct(null, layoutPtr)
      this.queue = this.queue.concat(generateQueue(layoutTree, true))
      this.queue.push({
        action: 'resize',
        index: this.paneNum - 1,
        layoutTree
      })
      if (typeof focusIndex !== 'undefined') {
        this.queue.push({
          action: 'jump',
          index: focusIndex
        })
      }
      this.queue.push({
        action: 'split',
        index: this.paneNum
      })
    }

    this.queue.pop()
    if (typeof gFocusIndex !== 'undefined') {
      this.queue.push({
        action: 'jump',
        index: gFocusIndex
      })
    }

    this.work()
  }

  work() {
    const {sessions, termGroups} = this.store.getState()
    const {lastIndex} = this
    const {activeUid} = sessions
    const lastPane = this.panes[lastIndex]

    if (this.queue.length > 0) {
      const item = this.queue.shift()
      const {index} = item
      const pane = this.panes[index]

      if (!lastPane.uid) {
        lastPane.uid = activeUid
      }

      this.lastIndex = index
      this.lastUid = activeUid
      switch (item.action) {
        case 'split':
          requestSession(pane.args, item.mode)
          break
        case 'cmd':
          if (pane.cmd) {
            if (typeof pane.cmd === 'string') {
              runCommand(activeUid, pane.cmd)
            } else if (typeof pane.cmd.shell_command === 'string') {
              runCommand(activeUid, pane.cmd.shell_command)
            } else if (Array.isArray(pane.cmd.shell_command)) {
              for (const cmd of pane.cmd.shell_command) {
                runCommand(activeUid, cmd)
              }
            }
          }
          this.work()
          break
        case 'resize':
          this.layoutResize(item.layoutTree, termGroups.activeRootGroup)
          this.work()
          break
        case 'jump':
        default: {
          const jumpTo = pane.uid
          if (jumpTo) {
            focusUid(this.store, jumpTo)
          }
          this.work()
        }
      }
    } else {
      if (this.reuseIndex > 0) {
        this.store.dispatch({
          type: 'HYPERINATOR_SWITCH',
          from: this.knownUids[0],
          to: this.knownUids[this.reuseIndex]
        })
      }
      hyperinator = null
    }
  }

  // A javascript rewrite of layout_construct in tmux
  layoutConstruct(lcParent, layoutPtr) {
    const posPattern = /^(\d+)x(\d+),(\d+),(\d+)(.*)$/
    const wpidPattern = /^,\d+([^x].*)$/
    const pos = posPattern.exec(layoutPtr.s)
    const lc = {}
    lc.parent = lcParent
    lc.sx = Number.parseInt(pos[1], 10)
    lc.sy = Number.parseInt(pos[2], 10)
    lc.xoff = Number.parseInt(pos[3], 10)
    lc.yoff = Number.parseInt(pos[4], 10)
    lc.cells = []
    lc.id = this.paneNum
    layoutPtr.s = pos[5]
    const wpid = wpidPattern.exec(layoutPtr.s)
    if (wpid) {
      layoutPtr.s = wpid[1]
    }
    switch (layoutPtr.s[0]) {
      case ',':
      case '}':
      case ']':
      case undefined: {
        this.paneNum += 1
        return lc
      }
      case '{':
        lc.type = 'LAYOUT_LEFTRIGHT'
        break
      case '[':
        lc.type = 'LAYOUT_TOPBOTTOM'
        break
      default:
    }
    do {
      layoutPtr.s = layoutPtr.s.slice(1)
      lc.cells.push(this.layoutConstruct(lc, layoutPtr))
    } while (layoutPtr.s[0] === ',')

    switch (lc.type) {
      case 'LAYOUT_LEFTRIGHT':
        if (layoutPtr.s[0] !== '}') {
          console.error('Layout format wrong!')
        }
        break
      case 'LAYOUT_TOPBOTTOM':
        if (layoutPtr.s[0] !== ']') {
          console.error('Layout format wrong!')
        }
        break
      default:
        console.error('Layout format wrong!')
        break
    }
    layoutPtr.s = layoutPtr.s.slice(1)
    return lc
  }

  layoutResize(layoutTree, termGroupUid) {
    const {termGroups} = this.store.getState().termGroups
    const termGroupTree = termGroups[termGroupUid]
    if (layoutTree.cells.length > 0 &&
       layoutTree.cells.length === termGroupTree.children.length) {
      let sizes
      if (layoutTree.type === 'LAYOUT_LEFTRIGHT') {
        sizes = layoutTree.cells.map((cell, i) =>
          (cell.sx + Boolean(i)) / layoutTree.sx)
      } else if (layoutTree.type === 'LAYOUT_TOPBOTTOM') {
        sizes = layoutTree.cells.map((cell, i) =>
          (cell.sy + Boolean(i)) / layoutTree.sy)
      }
      termgroupResize(this.store, termGroupUid, sizes)
      for (const [i, c] of layoutTree.cells.entries()) {
        this.layoutResize(c, termGroupTree.children[i])
      }
    }
  }
}

// Request new Session (Tab, Pane)
function requestSession(args, mode) {
  const payload = args
  switch (mode) {
    case 'LAYOUT_LEFTRIGHT':
      payload.splitDirection = 'VERTICAL'
      break
    case 'LAYOUT_TOPBOTTOM':
      payload.splitDirection = 'HORIZONTAL'
      break
    default:
      break
  }
  window.rpc.emit('new', payload)
}

// Runs command in given `uid`
function runCommand(uid, cmd) {
  if (cmd) {
    window.rpc.emit('data', {
      uid,
      data: ` ${cmd}\n\r`
    })
  }
}

// Focuses given `uid` – useful for pane operations
function focusUid({dispatch}, uid) {
  dispatch({
    type: 'SESSION_SET_ACTIVE',
    uid
  })
}

// Resize TermGroup with given `uid` and `sizes`
function termgroupResize({dispatch}, uid, sizes) {
  dispatch({
    type: 'TERM_GROUP_RESIZE',
    uid,
    sizes
  })
}

// Listens for cli commands and sessions
exports.middleware = store => next => action => {
  const {type, data, uid} = action

  // Check for hyperinator config
  if (type === 'SESSION_ADD_DATA') {
    const testedData = /\[hyperinator config: (.*)]/.exec(data.split(/\n/)[0])
    if (testedData && testedData[1] && fs.existsSync(testedData[1])) {
      store.dispatch({
        type: 'HYPERINATOR_LOAD',
        data: testedData[1]
      })
      return
    }
  }

  // Check for sessions
  if (type === 'SESSION_ADD' && hyperinator && !hyperinator.knownUids.includes(uid)) {
    hyperinator.knownUids.push(uid)
    setTimeout(() => {
      hyperinator.work()
    }, 0)
  }

  // Load a config
  if (type === 'HYPERINATOR_LOAD') {
    const {sessions} = store.getState()
    const config = yaml.load(fs.readFileSync(data, 'utf8'))
    hyperinator = new Hyperinator(config, store)
    hyperinator.knownUids.push(sessions.activeUid)
    return
  }
  next(action)
}

exports.reduceTermGroups = (state, action) => {
  switch (action.type) {
    case 'HYPERINATOR_SWITCH': {
      const fromTermGroupUid = findBySession(state, action.from).uid
      const toTermGroupUid = findBySession(state, action.to).uid
      if (!fromTermGroupUid || !toTermGroupUid) {
        return state
      }
      state = state
        .setIn(['termGroups', fromTermGroupUid, 'sessionUid'], action.to)
        .setIn(['termGroups', toTermGroupUid, 'sessionUid'], action.from)
      break
    }
    default:
      break
  }
  return state
}
