# You'll Miss It! link hub

A one-screen game that is the band's link hub: the visitor steers Greg up a dungeon, and each chest leads to one of the band's destinations.

## Language

### The dungeon

**Greg**:
The skeleton the visitor steers.
_Avoid_: player, character, hero

**Layout**:
One of the two maps of the dungeon, portrait or landscape, chosen by the shape of the viewport.
_Avoid_: level, stage, orientation

**Ledge**:
A platform that carries a chest.
_Avoid_: platform, floor

**Stepping stone**:
A platform with no chest, there only to make a climb possible.

**Chest**:
The object on a ledge that stands for one destination.
_Avoid_: box, link

**Destination**:
One of the five places the band sends visitors: Merch, YouTube, Listen, Instagram, Featured.
_Avoid_: link, site

### Collecting

**Visit**:
Leaving for a destination, by tapping its chest or its footer button.
_Avoid_: click, open

**Prize**:
The collectible a destination awards the first time it is visited.
_Avoid_: item, reward, collectible

**Inventory**:
The set of prizes the visitor has collected, shown as a bar at the top of the screen.
_Avoid_: collection, strip

**Reward beat**:
The short moment after the visitor returns from a visit, in which Greg receives the prize and cannot be steered.
_Avoid_: prize sequence, reward animation

**Completion**:
The state of holding all five prizes.

### Touch controls

**Hold**:
A finger resting on the left or right half of the map.
_Avoid_: press, touch

**Steering finger**:
The hold that decides which way Greg walks: the one that has been down longest.

**Flick**:
A quick upward movement of a finger, which asks Greg to jump. It can come from the steering finger or any other.
_Avoid_: swipe

**Tap**:
A press on the chest Greg is standing at, which makes a visit and never becomes a hold.

### Sound

**Bed**:
The ambient dungeon sound that plays when no song is audible.
_Avoid_: background music, ambience

**Song**:
The track belonging to one chest, heard only when Greg is near it.
_Avoid_: music, tune
