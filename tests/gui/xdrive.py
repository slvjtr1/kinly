"""Minimal X11 driver for GUI smoke tests (python-xlib XTest).

usage: xdrive.py click X Y | dclick X Y | move X Y | scroll X Y N | key KEYSYM [KEYSYM...] | type TEXT | shot PATH
"""
import sys
import time
from Xlib import X, XK, display
from Xlib.ext import xtest

d = display.Display()


def key(name):
    mods = []
    if "+" in name and len(name) > 1:
        *mods, name = name.split("+")
    codes = [d.keysym_to_keycode(XK.string_to_keysym(m)) for m in mods]
    code = d.keysym_to_keycode(XK.string_to_keysym(name))
    for c in codes:
        xtest.fake_input(d, X.KeyPress, c)
    xtest.fake_input(d, X.KeyPress, code)
    xtest.fake_input(d, X.KeyRelease, code)
    for c in reversed(codes):
        xtest.fake_input(d, X.KeyRelease, c)
    d.sync()


def move(x, y):
    xtest.fake_input(d, X.MotionNotify, x=int(x), y=int(y))
    d.sync()


def click(x, y, n=1):
    move(x, y)
    time.sleep(0.08)
    for _ in range(n):
        xtest.fake_input(d, X.ButtonPress, 1)
        xtest.fake_input(d, X.ButtonRelease, 1)
        d.sync()
        time.sleep(0.06)


cmd, *args = sys.argv[1:]
if cmd == "click":
    click(*args)
elif cmd == "dclick":
    click(*args, n=2)
elif cmd == "move":
    move(*args)
elif cmd == "key":
    for k in args:
        key(k)
        time.sleep(0.05)
elif cmd == "type":
    names = {" ": "space", "/": "slash", ".": "period", "-": "minus", ":": "colon", "_": "underscore"}
    for ch in args[0]:
        name = names.get(ch, ch)
        sym = XK.string_to_keysym(name)
        code = d.keysym_to_keycode(sym)
        # Characters on the shifted level of their key need Shift held.
        key(("Shift_L+" + name) if d.keycode_to_keysym(code, 0) != sym else name)
elif cmd == "scroll":
    # scroll X Y N  (N > 0: down)
    x, y, n = int(args[0]), int(args[1]), int(args[2])
    move(x, y)
    for _ in range(abs(n)):
        b = 5 if n > 0 else 4
        xtest.fake_input(d, X.ButtonPress, b)
        xtest.fake_input(d, X.ButtonRelease, b)
        d.sync()
        time.sleep(0.03)
elif cmd == "shot":
    from PIL import ImageGrab
    ImageGrab.grab(xdisplay=":0").save(args[0])
