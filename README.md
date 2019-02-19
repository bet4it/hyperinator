# Hyperinator

[![Build Status](https://travis-ci.org/bet4it/hyperinator.svg?branch=master)](https://travis-ci.org/bet4it/hyperinator) [![XO code style](https://img.shields.io/badge/code_style-XO-5ed9c7.svg)](https://github.com/sindresorhus/xo)

Hyperinator is a layout automation plugin for [Hyper.app](https://hyper.is).

Hyperinator bases on the code of [hyperlayout](https://github.com/timolins/hyperlayout), which is written by [Timo Lins](https://timo.sh).


<img src="https://github.com/bet4it/hyperinator/raw/master/assets/demo.gif">




# Install

```sh
$ npm install -g hyperinator
$ hyper i hyperinator
```

# Usage
Hyperinator uses [tmuxp](https://github.com/tmux-python/tmuxp)'s YAML config style. If you use [tmuxinator](https://github.com/tmuxinator/tmuxinator) or [teamocil](https://github.com/remiprev/teamocil), you can use [tmuxp](https://github.com/tmux-python/tmuxp) to [import](http://tmuxp.git-pull.com/en/latest/cli.html#import) their configs.

All configs must be stored in `~/.tmuxinator`.

Currently hyperinator only supports define layout with tmux's layout string, you can get it with `tmux list-windows -F "#{window_layout}"` in a tmux session.

For example, if you want get a sample layout with two pane:

```sh
$ cat ~/.hyperinator/sample.yml
```
```yml
windows:
- layout: 5162,237x48,0,0{118x48,0,0,152,118x48,119,0,153}
  panes:
  - echo 'First pane'
  - echo 'Second pane'
```
You can load this layout with:
```sh
$ hyperinator load sample
```

You will get a layout like:
```
.------------------.------------------.
| (0)              | (1)              |
|                  |                  |
|                  |                  |
|                  |                  |
|                  |                  |
|                  |                  |
|                  |                  |
|                  |                  |
|                  |                  |
'------------------'------------------'
```

A more complex config file which is used by the GIF above:
```yml
start_directory: ~/
windows:
- layout: e349,237x48,0,0{144x48,0,0,152,92x48,145,0[92x32,145,0,153,92x15,145,33,154]}
  panes:
  - shell_command:
    - echo 'Load demo layout!' > /tmp/test.txt
    - cat /tmp/test.txt
    focus: True
  - shell_command:
    - pwd
    start_directory: /tmp/
  - echo 'Hello world!'
  focus: True
- layout: f8cc,237x48,0,0{164x48,0,0,152,72x48,165,0,153}
  panes:
  - shell_command:
    - emacs -nw
    focus: True
  -
  start_directory: /etc
```
