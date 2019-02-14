const fs = require('fs')
const yaml = require('js-yaml')
const untildify = require('untildify')

let hyperlayout

// Generate Command queue from converted layout tree
function generateQueue(converted, initial) {
  let q = []

  if (converted.cells instanceof Array) {
    converted.cells.forEach((cell, i) => {
      if (i > 0) {
        q.push({
          action: 'split',
          mode: converted.type,
          pane: {index: cell.id}
        })
      } else {
        q.push({
          action: 'jump',
          pane: {index: cell.id}
        })
      }
      if (initial || i > 0) {
        q.push({
          action: 'cmd',
          pane: {index: cell.id}
        })
      }
    })
    converted.cells.forEach(cell => {
      q = q.concat(generateQueue(cell))
    })
  }
  return q
}

// Hyperlayout instance
class Hyperlayout {
  constructor({config, cwd}, store) {
    this.cwd = cwd
    this.store = store
    this.panes = []
    this.paneNum = 0
    this.lastIndex = 0
    this.knownUids = []
    this.layoutTree = {}

    const layoutPtr = {s: config.layout.substr(5)}
    this.layoutTree = this.layoutConstruct(null, layoutPtr)
    Array.from(new Array(this.paneNum), (x, i) =>
               this.panes.push({index: i, cmd: config.panes[i]}))
    this.queue = generateQueue(this.layoutTree, true)
    this.work()
  }
  work() {
    const {sessions} = this.store.getState()
    const {lastIndex, cwd} = this
    const {activeUid} = sessions
    const pane = this.panes[lastIndex]

    if (this.queue.length > 0) {
      const item = this.queue.shift()
      const {index} = item.pane

      if (!pane.uid) {
        this.panes[lastIndex].uid = activeUid
      }

      this.lastIndex = index
      this.lastUid = activeUid
      switch (item.action) {
        case 'split':
          requestSession(cwd, item.mode)
          break
        case 'cmd':
          runCommand(activeUid, pane.cmd)
          this.work()
          break
        case 'jump':
        default: {
          const jumpTo = this.panes[index].uid
          if (jumpTo) {
            focusUid(this.store, jumpTo)
          }
          this.work()
        }
      }
    } else {
      this.layoutResize(this.layoutTree,
                        this.store.getState().termGroups.activeRootGroup)
    }
  }
  // A javascript rewrite of layout_construct in tmux
  layoutConstruct(lcParent, layoutPtr) {
    const posPattern = /^(\d+)x(\d+),(\d+),(\d+)(.*)$/
    const wpidPattern = /^,\d+([^x].*)$/
    const pos = posPattern.exec(layoutPtr.s)
    const lc = {}
    lc.parent = lcParent
    lc.sx = parseInt(pos[1], 10)
    lc.sy = parseInt(pos[2], 10)
    lc.xoff = parseInt(pos[3], 10)
    lc.yoff = parseInt(pos[4], 10)
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
        this.paneNum = this.paneNum + 1
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
      layoutPtr.s = layoutPtr.s.substr(1)
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
    layoutPtr.s = layoutPtr.s.substr(1)
    return lc
  }
  layoutResize(layoutTree, termGroupUid) {
    const termGroups = this.store.getState().termGroups.termGroups
    const termGroupTree = termGroups[termGroupUid]
    if (layoutTree.cells.length > 0 &&
       layoutTree.cells.length === termGroupTree.children.length) {
      let sizes
      if (layoutTree.type === 'LAYOUT_LEFTRIGHT') {
        sizes = layoutTree.cells.map(cell => cell.sx / layoutTree.sx)
      } else if (layoutTree.type === 'LAYOUT_TOPBOTTOM') {
        sizes = layoutTree.cells.map(cell => cell.sy / layoutTree.sy)
      }
      termgroupResize(this.store, termGroupUid, sizes)
      layoutTree.cells.forEach((c, i) =>
                               this.layoutResize(c, termGroupTree.children[i]))
    }
  }
}

// Request new Session (Tab, Pane)
function requestSession(cwd, mode) {
  const payload = {cwd}
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

  // Check for hyperlayout config
  if (type === 'SESSION_ADD_DATA') {
    const testedData = /^\[hyperlayout config]:(.*)/.exec(data)
    if (testedData && testedData[1]) {
      const cfg = yaml.safeLoad(fs.readFileSync(testedData[1], 'utf8'))
      const cwd = untildify(cfg.root)
      const windows = cfg.windows[0]
      const config = windows[Object.keys(windows)[0]]
      hyperlayout = new Hyperlayout({cwd, config}, store)
      return
    }
  }

 // Check for sessions
  if (type === 'SESSION_ADD' && hyperlayout) {
    // Check if it's a new session
    if (!hyperlayout.knownUids.includes(uid)) {
      hyperlayout.knownUids.push(uid)
      setTimeout(() => {
        hyperlayout.work()
      }, 0)
    }
  }
  next(action)
}
