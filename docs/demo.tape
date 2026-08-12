# Recording script for the README demo GIF.
#
#   vhs docs/demo.tape          # needs vhs + ttyd + ffmpeg (WSL / Linux / macOS)
#
# Runs against a throwaway database so the recording never touches a real index.

Output docs/demo.gif

# --- Frame ------------------------------------------------------------------
# The window bar and the inset margin are what separate this from a screen
# capture: the GIF reads as a picture of a terminal rather than a piece of one.
Set WindowBar Colorful
Set WindowBarSize 40
Set BorderRadius 12
Set Margin 60
Set MarginFill "#171320"
Set Padding 28

# --- Type -------------------------------------------------------------------
# FontFamily is a request, not a guarantee: VHS falls back silently to whatever
# the recording box has, so install the font there or the GIF ships in DejaVu.
Set FontFamily "JetBrains Mono"
Set FontSize 20
Set LineHeight 1.4
Set Theme "Catppuccin Mocha"

# --- Motion -----------------------------------------------------------------
# A blinking cursor costs frames all through the idle Sleeps and buys nothing.
Set TypingSpeed 55ms
Set CursorBlink false
Set Width 1200
Set Height 760

# The first frame a README shows is the thumbnail. Start the loop partway in so
# that frame has output on it instead of an empty prompt.
Set LoopOffset 35%

# Setup is recorded but not shown: clean db, quiet prompt, no git noise.
# The prompt is hardcoded rather than starship on purpose -- a prompt that
# renders the current branch makes the recording differ run to run.
Hide
Type "export PATH=$HOME/bin:$PATH" Enter
Type "export NEXUSMEM_HOME=$(mktemp -d)" Enter
Type `export PS1='\[\e[38;5;141m\]❯\[\e[0m\] '` Enter
Type "clear" Enter
Show

Sleep 1s

Type "nexusmem init" Sleep 400ms Enter
Sleep 2s

Type "nexusmem sync" Sleep 400ms Enter
Sleep 6s

Type "nexusmem status" Sleep 400ms Enter
Sleep 4s

Type `nexusmem query "windows spawn failure"` Sleep 400ms Enter
Sleep 6s

Sleep 2s
