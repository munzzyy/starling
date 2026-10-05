# Changelog

All notable changes to Starling are recorded here. Versions follow
[semantic versioning](https://semver.org).

## [Unreleased]

- **People whose phones have gone quiet stay on the sheet.** A member who
  had not posted in a day dropped off the list, and when that was everyone
  the sheet said "Just you here so far" and asked you to send invites to
  people already in the circle. They now keep a dimmed card that says there
  is no recent update, and a tap on it opens People and keys.

- **Give anyone in your circle a name only your phone uses.** Two people
  can both call themselves Mom, and anyone can rename themselves to look
  like someone else. People and keys now has a field for your own name for
  each person. Cards, markers and alerts use it, the sheet still shows the
  name they go by, and it never leaves the phone.

- **Mute one person's place and battery alerts.** Somebody who walks past
  a saved place every day or always runs low on battery made those alerts
  noise for the whole circle. Each person in People and keys now has a
  switch that keeps their arrivals, departures and low battery quiet on your
  phone. Their card still says where they are, and an SOS, a missed
  check-in or a key change from them still comes through.

- **People and keys keeps working after you accept someone's new keys.**
  Their row lost track of who it belonged to, so Mark verified and Remove
  did nothing for that person until Starling was restarted.

## [0.17.1]

- **Scanning a code works again on Android.** The camera was refused to
  Starling's own page even with the permission granted, so every scan said
  camera access was turned down (#23). Android hands the page's address over
  with a slash on the end and the check did not allow for it. Scanning an
  invite or a safety number opens the camera again, and the camera still
  goes only to the app's own page.

## [0.17.0]

- **A restart or an update no longer ends a share in silence.** Sharing
  already came back when you opened Starling, but nothing told you it had
  stopped. Now one notification says so, with a tap to share again (#22). It
  names no circle and no person, and stays away when you stopped the share
  yourself, a timed share has run out, or after a panic wipe. The tap opens
  the app, so the app lock still asks for the passcode first. Starling cannot
  turn the share back on by itself: Android 11 and later give an app with
  while-in-use location no fixes from a service started at boot, and Android
  14 and later refuse to start it. docs/ANDROID.md has the emulator results.
- **A timed share picked after sharing started now ends on time after the app
  is closed.** The window you chose was not written down, so a reopen brought
  the share back with no end. The same happened to a timed share that had
  already come back once.

## [0.16.1]

- **Untranslated labels.** The status chips (On my way, Here, 5 minutes,
  Running late, Busy), the status field hint, and the name and link-label
  hints showed English in every language. They are translated now, and the
  string tests fail on a label table or a placeholder that skips the
  translator, which is how these got past them (#1).

## [0.16.0]

- **Check-in timer.** A new button next to People and keys and Places sets a
  deadline from 30 minutes to 8 hours. While it runs, every post carries the
  deadline inside the encrypted message, and each phone in your circle tells
  its person when it passes without a check-in: an urgent notification, and a
  card that stays on the sheet with your last position. Your own phone warns
  you five minutes before. Only a check-in you tap stops it. Stopping sharing,
  the app lock, leaving and wiping do not, on purpose. Phones on older
  versions ignore the deadline and are not told.
- **An SOS that goes quiet stays an SOS.** A member whose phone stopped
  sending in the middle of an SOS used to turn into "Last seen" and sink below
  everyone still live, at exactly the moment the circle most needs them on top.
  They keep the red chip and the top of the list now, with "Signal lost" on
  their line, and your phone says once that the SOS went quiet. An incoming SOS
  also leaves a card on the sheet with Show on map, until they check in, say
  bye, or you tap Got it. The help link page still reads "Signal lost".
- **Choose which arrivals and departures each place tells you about.** Every
  saved place has Both, Arrive, Leave or Off under Places, so "tell me when
  she leaves school" no longer comes with three other alerts a day. Off keeps
  the "At School" line on the member card and stays silent. Places saved
  before this keep saying both, and the switch in Settings still silences
  all of them.
- **Your own low battery offers the slower cadence.** Below 15% while sharing
  every 15 seconds, a card says so and offers Every 5 minutes for this circle,
  one tap, with Not now to wave it off until the phone has charged past 25%.
  Nothing slows down unless you tap it, and an SOS still goes every 15 seconds.
- **The help link page gives a helper something to act on.** Under the name it
  now shows the coordinates to five places with a Copy button, an Open in a map
  app link, how accurate the fix is, the phone's battery, and the time the link
  stops working. The status word sits in a polite live region and the ended and
  expired notices are alerts, so a screen reader hears the session change. The
  battery reading is new on what the help link receives, the same one the
  circle gets.
- **Only your language loads.** The app and the help link page pulled all four
  translations on every start, which on the help page was 283 KB of its 399 KB
  of script before it could draw. A catalog now loads only when its language is
  chosen, so an English help link fetches about 120 KB, and a language added
  later costs nothing to the people who do not use it.
- **German, French and Brazilian Portuguese.** The whole app, the Android
  notifications and the update-your-WebView screen, under Settings, Language
  or following the phone's language. These are first passes; Spanish had a
  native speaker read every line, and the other three want the same, so
  anything that reads wrong deserves an issue.
- **Argon2id behind the app lock.** The passcode is stretched with Argon2id
  (64 MiB, three passes) instead of PBKDF2, so every guess costs an attacker
  the memory it costs your phone. The function is the Argon2 reference
  implementation compiled to a WebAssembly module that imports nothing, built
  from a pinned commit with every source file's hash checked, and the app
  hashes the module before it runs it. Existing locks keep opening; the next
  time you type the passcode the key is re-wrapped under Argon2id. A duress code set earlier
  keeps its old verifier until you set it again. docs/ARGON2.md has the
  rebuild and check steps.
- **Precision and cadence per circle.** Settings, Sharing now belongs to the
  circle you are in, and says which one. Each circle keeps its own precision
  (precise or neighborhood) and how often your position goes out while you
  stay put: every 15 seconds, every minute or every 5 minutes. Switch circles
  and both switch with you. On Android the service wakes the phone on the
  circle's cadence instead of every 15 seconds. Moving still sends sooner
  unless Steady sending is on. An SOS goes out every 15 seconds no matter what
  the circle asked for. Circles from before this keep working as they did: the
  old device-wide precision stands in until a circle picks its own.
- **A slow sender is not a dead one.** Each post now says how often its sender
  posts. A phone on this version waits for two missed posts before it shows
  "Last seen", and never less than the usual three minutes. The other way to
  do this was to stretch the three minutes for everyone, which would have
  hidden a phone that really had died. Phones on older versions do not read
  the new field, so they show a 5 minute sender as "Last seen" between posts.
- **Safety numbers as QR codes.** People and keys has "Show as QR" under your
  own number and "Scan theirs" to read the other phone's. A scan looks the
  member up in your pinned roster, works their number out again from the keys
  you hold, and compares. A match offers the same verified mark the in-person
  compare does; a different number is a warning in the words a key change
  gets, and a code for somebody you have not pinned says so. The decoder is
  in-house, like the encoder, and reads versions 1 to 10 at every error
  correction level, rotated, tilted, blurred or noisy, with the camera
  stopped the moment a code reads. The app asks for the camera on the tap and
  grants it to the bundled page only. On the website the scanner is off,
  since the site's headers deny the camera; the code still shows there.
- **An SOS rings through Do Not Disturb.** On Android an SOS from your circle
  now posts as an alarm. A phone in Do Not Disturb still rings for it when
  alarms are allowed, which is the default, and it plays at the alarm volume.
  To let it through total silence too, open Settings and use the button under
  Places and alerts. The notification text is the same generic line as before.
- **The sharing notification comes back.** Android 14 and later let the
  "Sharing with your circle" notification be swiped away on an unlocked phone
  while the share kept running. Anyone holding the phone for a minute could
  hide that it was sharing. Starling puts it straight back now for as long as
  the share runs.
- **Theme Auto follows the phone on Android.** Auto used to stay light on a
  phone in dark mode because the WebView inside the app never saw the phone
  setting. It follows dark mode now, also when the phone switches while
  Starling is open. The icons in the status and navigation bars match the
  theme you picked too, so the Light theme no longer gets white icons on a
  white bar.
- **Remind me to share again.** Settings, Sharing on Android has "Remind me
  if sharing stays off" (#6). Pick 1, 4 or 12 hours and a stop you made
  yourself leaves a notification on this phone after that long, or up to 10
  minutes later, unless you are sharing again by then. It says only that
  sharing is off and nothing goes to your circle. The default is Never.
  Please say on #6 if it never shows up on your phone.
- **No Safe Browsing lookups or WebView metrics.** On phones with Google's
  WebView the app could have its page checked by Safe Browsing and its use
  counted in WebView metrics. Both are off now. The autofill lookup some
  WebView builds make on their own has no off switch an app can reach, and
  docs/ANDROID.md says so.
- **Send opens the share sheet on Android.** Send the link on an invite and
  Send on a help link quietly copied the link instead. The WebView inside
  the app has no web share, so the app now opens the Android share sheet
  itself and leaves the clipboard alone. The link is still copied when there
  is no window to show the sheet in.
- **The relay refuses an oversized post without reading it.** The Cloudflare
  relay read a whole post into memory before it checked the size, so one huge
  post could crowd an isolate that serves many people. A post that says it is
  too large is refused before any of it is read now, and one that does not
  say is cut off at the limit. The relay on your own server already had a cap.
- **Scan an invite code inside the app.** The sheet behind I have an invite
  and Join with invite now has Scan a code next to the paste field, so joining
  no longer needs a separate camera app (#18). An invite that reads goes to the
  same join request a pasted link does, and the camera stops first. A safety
  number code is named as one and other codes are turned away while the camera
  keeps looking. The website has no scanner, as before.

## [0.15.2]

Invites work on your own relay.

- **Invites on your own relay.** An invite link made on a phone that uses a
  custom relay now carries the relay's address. Before, the phone that opened
  it asked to join through its own relay, the default one on a fresh install,
  so the request never reached a self-hosted relay (#9). A phone with no
  circle yet shows the address and switches to it when you ask to join. A
  phone already in circles on another relay says which relay the invitation
  needs instead. Links made on the default relay are unchanged, so older
  versions still open them.
- **Relay on the first screen.** "Use your own relay" on the first screen sets
  a custom relay before you create a circle, with no restart, so the phone
  that starts the circle can begin on your relay.

## [0.15.1]

A tracker ID for your own server.

- You can now give your phone a tracker ID under Settings, Sharing, Your own
  server. Starling sends it as `tid` with every position. If colota-forwarder
  has a target set to `FILTER_TID`, it drops any point without a matching
  `tid`, which is why Starling's points never got to Reitti or Home Assistant
  (#10).

## [0.15.0]

Starling runs on Android 9.

- **Android 9.** Starling installs on Android 9 now. The first time it opens
  there, it says once that Android 9 has had no security fixes since January
  2022, and that the location permission covers all the time, since Android 9
  has no "only while using the app" choice. Sharing with the screen off works
  the same as on newer phones.
- **Old WebViews.** With an Android System WebView older than 137, the app
  says which version it needs instead of loading. Older versions can't check
  the Ed25519 signatures newer phones make, so people in your circle would
  quietly stop showing up.

## [0.14.0]

Your position can go to your own server too, and the relay can run on one.

- **Your own server.** Settings, Sharing can send your own position, in
  OwnTracks format, to a server you run, like Reitti, Dawarich, Home Assistant
  or colota-forwarder, while you share (#10). It goes straight from the phone
  over https, at most every 15 seconds, and never while Tor mode is on. It is
  loud on purpose. The sharing notification and the line under your name name
  the server, and with the app lock on, changing it needs your passcode.
- **A relay on your own server.** `node relay/server.mjs` runs the relay under
  plain Node with a SQLite file, behind Apache or nginx, with no Cloudflare
  account (#9). `docs/SELF-HOSTING.md` has the setup.

## [0.13.5]

KC5YVV's Pixels were still going quiet the moment they were locked and put
down, and one of them drove twelve miles without a single update. 0.13.4
looked fixed because every test was shorter than five minutes. The real cause
only shows after that.

- **A locked phone keeps sharing.** Chromium freezes a page that has been
  hidden for a while: five minutes on older WebViews, one minute on current
  ones. Positions still reached the frozen page, but nothing after that ran,
  so nothing was posted until someone opened the app, and then the whole
  backlog went out at once. Starling now wakes the page for a second whenever
  it freezes during a share. On an Android 16 image, locked with the app open
  and moving for seven minutes, it posted 88 of 88 times, straight through
  the freeze. Before, the posts stopped at the freeze. The frozen page had
  also stopped checking for an SOS from anyone else, and while you share it
  keeps checking now too.
- It works the same with the app swiped away. A page with no window could
  never be woken, so "Keep sharing when the app is closed" had the same limit.
  Starling now keeps the page in a window of its own that never shows
  anything. Tested on Android 10 and 16.
- **Android stopping a share is no longer silent.** With battery use set to
  Restricted, Android stops a share about a minute after you leave the app,
  and the app kept saying "Sharing live". Opened from its notification,
  Starling also closed on Back and took the share with it. Back now leaves the
  app the way Home does. When Android stops a share you get a notice, opening
  the app puts it back on, and a card says how to keep it from happening.
- **Neither is the app lock.** A locked Starling holds no keys, so with "Keep
  sharing when the app is closed" off, the auto-lock has to end a share. It
  did that without a word, and the goodbye to your circle was cut off before
  it left, so they saw a dot that stopped moving. The goodbye goes out first
  now, you get a notice, and getting back into the app puts the share back on. Starting a
  share with the lock on shows a card with one tap to keep sharing instead.
- The line under your name says when your last position went out once that is
  more than a minute ago, and stops saying "Live" when your circle has stopped
  hearing from you. Location switched off is said there and on the
  notification, and your circle sees you go quiet instead of a live dot where
  you used to be.
- **The panic wipe inside the app works again.** Since 0.13.0 it failed
  whenever it ran from inside the app, the duress passcode included: the
  wrapper tried to take the page down from the wrong thread and stopped there.
  The page still erased its own storage, but nothing else went. Cached map
  tiles of where your circle had been, the biometric key and the settings the
  Android side keeps all stayed on the phone, a running share kept going with
  the phone held awake, and the app sat on an error page until it was force
  stopped. It now stops the share and clears everything, and the app closes.
  The PanicKit trigger left the notification channels behind when it fired
  during a share, and no longer does.

On a phone that optimizes Starling's battery use, starting a share now asks
once whether it may run in the background. "Not now" is final, and Settings
shows the state under Sharing either way. Settings can also copy a sharing
report for bug reports: versions, permission and battery settings, and counts,
with nothing in it that says where you are or who is in your circle.

Smaller fixes on the same path: the phone stays awake just long enough to post
each position, a position that arrives while new keys are being adopted waits
for them instead of being dropped, a slow network no longer queues one post
per fix, the app lock locks on the way back in if a frozen page slept through
its timer, and opening the app in the second the page is awake no longer
skips what the app does when you come back to it. The notice after a stop
only says the app was closed when it was.

## [0.13.4]

After 0.13.3, a closer look at everything else that could stop a share once the
app is closed, on real phones rather than the emulator. Four real ones.

- **The app lock no longer ends a share you asked to keep.** With app lock on,
  closing Starling started the auto-lock timer, and locking drops the keys,
  which ended the share a minute later (or at once with "Now"). Opening the
  app and entering the passcode then put it back on, which looked exactly like
  a swipe stopping it.
  The switch already said the lock cannot protect the keys until the share
  ends; now the code agrees. The lock is armed the moment the share ends.
- **A phone that isn't moving keeps posting.** Positions only came through
  after about 5 metres of movement, and the regular send ran on a page timer
  that barely runs with the app closed. A phone left on a desk went quiet and
  looked stopped to everyone watching. The service now also sends a position at
  least every 15 seconds, and the page posts on that schedule. That includes
  "Steady sending", which relied on the timer alone.
- **Android killing the page no longer kills the app.** If Android reclaims the
  part of Starling that runs the page, which it does under memory pressure, the
  whole app used to go down with it: the share ended silently, with no notice.
  Now the app survives, you get the usual notice, the next open says Android
  did it, and an open window gets a fresh page straight away.
- **One stuck upload can't hold up the rest.** Every post waited on two storage
  writes, and a post that never got an answer (a network handover, a stalled
  Tor circuit) blocked every post after it. The timestamp now lives in memory,
  and a post gives up after 20 seconds.

## [0.13.3]

KC5YVV found that "Keep sharing when the app is closed" did not keep sharing on
their Pixels, and they were right. The share looked on and posted nothing.

- **Positions now reach the page while the app is closed.** Every fix was handed
  to the page with `View.post`, which a view with no window holds until it is
  attached again. So with the app swiped away, each position waited in a queue
  that only drained when you reopened Starling, and nothing was sent in
  between. Fixes now go through the main thread's handler. On an Android 16
  image, swiped away with the screen off, the page took 12 of 12 fixes and made
  15 accepted posts; before this change it took none.
- **Reopening the app no longer restarts the share.** Opening Starling
  re-applied the network proxy setting every time, and applying it reloads the
  page. That threw away a share that had been running on its own and started a
  new one, which is where "Sharing was on when the app closed, so it is back on"
  came from. The setting is only applied again when it has actually changed.
- **An old swipe notice no longer sits under a live share.** Turning sharing on
  yourself clears a record left by an earlier swipe. A Stop tapped on the
  notification is still kept, because someone doing that is worth knowing about.
- **More of the map speaks Spanish.** Your own marker, an unnamed member, the
  demo position and a couple of fallbacks still said "You" or "Someone" in
  English. Toasts also no longer land on top of the demo banner.

## [0.13.2]

Mostly the website and the store listing. In the app, Settings now says who
made it.

- **The site says Starling is on F-Droid.** It has been since 09-23, and the
  install card still said "in review". F-Droid is now the first route, and the
  card says it ships the same signed APK as GitHub, so you can switch sources.
- **The privacy policy describes v2.** It still said the circle secret rides in
  invite links, that the demo never touches the network, and that the passcode
  is stored. None of that is true of 0.13.1. The effective date moved with it.
- **The privacy page and the APK download work again after visiting the
  site.** The service worker answered every page with the cached landing, so
  the footer's Privacy link showed the landing a second time and "Download the
  APK" gave a returning visitor the landing instead of the file.
- **Settings says who made the app**, with a link to the source.

## [0.13.1]

- **Settings shows the version you actually have.** The About line was typed in
  by hand and had said 0.8.0 since 0.8.0, so every build after it looked out of
  date (#7). It now reads one version file, and a test fails if that file, the
  Android build and package.json ever disagree.

## [0.13.0]

Catalyze4 answered the question 0.12.1 asked. Resume on reopen is no use to
somebody who closes every app when they are done with it and never goes back, so
sharing now has the option of outliving the app.

- **Keep sharing when the app is closed, off by default, in Settings under
  Sharing.** Swiping Starling out of recents normally stops a share, because the
  code that seals each position lives in the page and the page died with the
  window. With the switch on, the page is held by the process rather than by the
  window: the activity borrows it while there is a screen, a task removal takes
  the screen and leaves the page, and the share carries on. No encryption moved
  into the wrapper, so nothing changed about who can read a position.
- **What it costs, said in the setting itself.** A phone you believe you closed
  is still running Starling and still holding your circle's keys, and the app
  lock cannot protect them until the share ends. That is why it is a switch and
  not the new behaviour.
- **The page is released the moment the share ends.** A share that ends with
  nothing on screen takes the page down with it a few seconds later, once its
  departure is on the relay, so keys never outlive the share that needed them.
- **Nothing that has to happen on time rides on a page timer any more.** A page
  with no window is hidden, and a hidden page gets its timers throttled: on a
  real Android image a one second timer had not fired twenty seconds later, while
  script the wrapper pushed in ran at once. So a share stops everything it is
  running before it waits on storage, and a timed share ends off the next
  position the service delivers rather than off its own countdown.

Verified on an Android 16 image with the switch both ways, which is the only
honest way to check this: with it on, the process, the service and the page all
outlive the swipe and positions keep reaching the relay; with it off, the same
swipe gesture ends the process and nothing more is sent.

## [0.12.1]

Two people with four phones between them reported the same thing: sharing was
on, the app got closed, and reopening showed sharing off. Separately, a stranger
read the protocol and found that two members re-keying at the same moment split
a circle in half without telling anyone.

- **A share survives the app closing.** Sharing has always run in a foreground
  service typed for location, so a backgrounded app or a dark screen kept it
  going, but swiping the app out of recents ends it: the part that seals each
  position lives in the page, and a torn-down process has no keys left to seal
  with. That has not changed, and it cannot without moving the encryption out of
  the page. What has changed is that the app now writes down that a share was
  running, and puts it back when you next open it, with a line saying so. A
  share you ended yourself never comes back: pressing Stop on the notification
  is a decision, and it is remembered as one. A timed share that ran out while
  the app was closed stays ended, and one with time left comes back with the
  remainder rather than a fresh window. A locked phone resumes nothing until it
  is unlocked, because a locked phone holds no keys.
- **Two members re-keying at the same moment no longer split the circle.** Each
  rotator opened its own next generation on its own channel, and moving tore
  down the poller on the channel it left, so neither ever saw the other and
  everybody else followed whichever re-key they happened to read first. Nothing
  surfaced it: each side's roster agreed with the rotator it had followed. The
  generation just left now stays readable for five minutes on its old channel, a
  competing re-key for the same generation is settled by lowest member id, and
  the losing side rewinds to the generation both rotators started from and
  adopts the winner. No new crypto and nothing new on the wire, since every
  rotator already wraps to every member it keeps.
- **That window is never opened over a membership change.** A member removed by
  a re-key still holds the old channel's keys, and the window remembers the
  roster from before the move, so a window opened over a removal would have let
  them post a competing re-key and be adopted back into the circle by their own
  removal. So a re-key that removes or admits anyone opens no window at all, and
  a re-key carrying removals beats a plain one whatever the ids say, so a removal
  is never dropped by a coin toss.
- **A Stop you pressed days ago no longer blocks today's resume.** Nothing
  clears that record except dismissing the card it puts on screen, so it sits
  there through every later share. The resume now only treats it as a decision
  when it happened after the share it is refusing to bring back, and an undated
  record still counts as one, because refusing to resume is the safe way to be
  wrong.
- **The card about the app being closed no longer contradicts the resume.** It
  said sharing stops every time the app closes, which was true until this
  release and was sitting under a line saying sharing was back on. It says what
  happened now, and goes back to the general wording if you turn sharing off.
- **Relicensed to GPL-3.0-or-later.** Releases up to v0.11.0 stay under MIT.

Known gap, written where it belongs rather than hidden: the grace window lives
in memory, so a device that restarts inside those five minutes comes back on the
generation it had, exactly as it does today.

0.12.0 was tagged and never published. Everything written up here was in it, and
the last two entries are why it was not the release.

## [0.11.0]

An outside review picked apart 0.10.0's lock-screen notifications, and the
first two fixes for it didn't actually hold either.

- **Notifications stopped naming anyone, for real this time.** SOS,
  arrivals, departures, check-ins, and low battery all used to put a
  member's name or a place straight into the notification, on the
  assumption that Android's own "hide sensitive notification content"
  setting would cover the lock screen. That setting ships off by default,
  so the real name showed up on a locked phone anyway, which is the one
  moment anyone holding the phone should learn the least. Every event
  notification is now one generic line, on every phone, with nothing to
  turn on first; the real detail still shows once the app itself is
  reopened. SOS keeps its urgency without saying more: it gets its own
  alert channel, sound, and vibration, so it still stands out from a
  routine low battery ping even though the words on screen are the same
  shape.
- **Stopping a share from the lock screen now needs an unlock, and leaves
  a trace either way.** The ongoing "Sharing with your circle"
  notification's Stop button fired with no unlock required, and tapping
  it left no record anywhere, while swiping the app away at least posted
  "Sharing stopped." Stop now requires authentication on Android 12 and
  up (there is no such gate on 11 and below, and the threat model says
  that plainly now instead of hinting at it), and whichever way a share
  ends, a local record survives even a swipe and turns into a card the
  app shows the next time someone opens it.
- Dropped the USE_FINGERPRINT permission androidx.biometric was quietly
  declaring for phones older than this app has ever supported, and CI
  now fails the build if the APK picks up any permission outside the
  seven it is supposed to have.
- The threat model names Cloudflare directly as the relay operator, says
  plainly what it can and cannot see, and adds that Android's own
  foreground service notification tells anyone holding the phone that
  Starling is installed and sharing right now, which no code here can
  hide.

## [0.10.0]

- **Private zones.** Mark a place as a fence and your dot snaps to its
  center before anything is sealed: your circle sees you at the place,
  never which corner of it. Precise mode only (snapping a coarse point
  would sharpen it), SOS always sends the real spot, and the traffic is
  byte-identical - the e2e now reads the relay's own feed while a fence
  is active to prove it cannot tell.
- **Messages that arrive.** A memory-only outbox retries byes, check-ins,
  and SOS with fresh seals until they land. Locks and the panic path
  empty it first, and a test proves it never touches storage.
- **Sharing that stops by itself.** One hour, two, or four, through the
  same authenticated goodbye a manual stop uses.
- **Smarter arrivals.** Place detection reads fix accuracy and holds
  impossible jumps until a second fix agrees, so arrival alerts stop
  crying wolf.
- **The rendezvous compass.** "188 m to the southeast of you" on a
  member's card, computed entirely on the device.
- **The access ledger.** The members sheet counts the keys that could
  decrypt you, in exactly those words, and a complete export shows every
  byte the app holds.
- **A living map.** Markers drop in, fresh fixes ping, staleness breathes,
  check-ins bloom, screens rise, and the landing hero has its
  murmuration. All of it sits out under reduced motion.

## [0.9.0]

- **The demo can show a real map.** A "Real map" button in the demo banner
  offers street tiles of the demo's Central Park stage, behind a consent
  note that names the one network request it would make. The demo still
  starts off-grid, cancel still means zero requests for the whole visit,
  and exiting without a circle goes back to off-grid rather than quietly
  loading the default basemap.
- **An iOS app exists.** `ios/` holds a WKWebView wrapper around the same
  bundled app, serving it on `starling://localhost` and holding a real
  circle. Build-from-source only (Xcode; a free Apple ID re-signs every 7
  days), no background sharing (iOS offers no equivalent of the Android
  foreground service), WebKit storage excluded from iCloud backups, and
  the full capability table lives in `docs/IOS.md`. The threat model
  gained an "iOS app deltas" section; the relay now accepts the wrapper's
  origin.

## [0.8.0]

- **Starling habla español.** The app has a translation layer now (gettext
  style: the English source string is the key, catalogs ship with the app,
  nothing is fetched) and Spanish is the first translation, covering all
  ~390 strings of the app surface: lock screen, sharing, SOS, places,
  captions, settings, the alert cards, the help beacon page, the Android
  notifications, and the demo's own story. Pick it in Settings or let
  "Auto" follow the system language. Honest caveats, also in the threat
  model: the Spanish is developer-reviewed but not yet community-reviewed,
  the website and long docs are still English, and no right-to-left
  language ships yet, though the engine and document wiring are ready for
  one. `node tools/extract-strings.mjs` prints the full catalog for anyone
  who wants to add a language, and a test refuses any new UI string the
  shipped catalog does not cover.
- An untranslated string always falls back to English rather than to a key
  or a blank, and user content (names, captions, circle names) never passes
  through the translator.

## [0.7.1]

- **The demo grew into a real tour.** It now shows Places: two invented
  spots, Home under your own feet and a fountain Mabel walks to, with her
  arrival firing the same on-device alert a real circle gets. Walkers carry
  status captions ("coffee run", "phone's dying"), Ash's battery is low
  enough to trip the warning, and the SOS arc repeats on a two-minute cycle
  for anyone who keeps watching. Mabel's caption flips on the same geometry
  the place tracker judges, so her card can never say "omw" and "At The
  fountain" at once. The demo's places are swapped in for the demo and back
  out after; the real list is never touched, and editing places mid-demo is
  gated. Still fully offline: no tiles, no network, nothing real.

## [0.7.0]

Six critics were pointed at 0.6.1 before this release: a parent who just
left Life360, a teenager, a screen-reader user, a Guardian-Project-style
reviewer, a security auditor, and a first-run user. What follows is what
they found, fixed.

- **Alerts actually reach a pocketed phone now.** The poller used to stop
  the moment the app was hidden, everywhere, which quietly hollowed out the
  background notifications 0.6.0 promised. The Android app now keeps
  listening in the background at a relaxed cadence (the sharing service
  keeps it alive), so a member's SOS lands as a notification while the
  phone sits in a pocket. The web keeps its hidden-tab pause. The threat
  model now states the delivery model exactly, including what a phone with
  the app closed does and does not see.
- **Status captions.** A few words on your own dot: "omw", "here", "at the
  north gate". Tap your name to set one. It rides inside the same
  encrypted, padded payload as everything else, only speaks while you are
  live, and clears itself when you stop sharing.
- **Join flow, humanized.** Both hinge moments notify (request received,
  request accepted). The waiting card admits when it has been a while and
  says what to do. A refused welcome no longer flatly announces an attack
  the code cannot distinguish from a stale retry. The joiner's circle-name
  field explains why it is blank. Safety-number screens say in plain words
  what the check is for, and tapping any safety number opens it full
  screen in large type for comparing phones side by side.
- **Warned before stranding, told when cut off.** Accepting a member or
  making new keys now warns when someone has been quiet for over an hour
  and might miss the new keys. And a circle that goes silent for 45
  minutes while you share raises a gentle card naming the one cause the
  app can do something about.
- **Accessibility.** SOS can be held via keyboard. The bottom sheet's
  grabber is a real button with a real name. System font size scales the
  whole app (WebView textZoom). Amber and rose text hold AA contrast in
  the light theme. Compact icon buttons grew 44px hit areas. The
  connection dot speaks. Firing SOS surfaces its own cancel instructions.
- **Swiped away means told.** Removing the app from recents while sharing
  posts a "Sharing stopped" notification instead of ending the share in
  silence.
- **Tor mode explains itself.** If Orbot never answers the port question,
  the app now says so and names the fix (Power User Mode, or Orbot's
  per-app VPN). docs/TOR.md gained an honest section on Cloudflare versus
  Tor exits and the self-host escape hatch.
- **Cheaper to flood, for the attacker's sake of it.** A joiner now
  refuses non-inviter identities with a hash compare before spending
  signature verifications on their messages. A new test proves welcome
  wraps and re-key wraps can never open as each other.
- Copied invite links now get five minutes before the clipboard clears,
  and the clear announces itself. Location-permission help inside the app
  points at the app's own settings screen, with a button that opens it.
- The landing page says out loud that the app is Android-only, what
  Starling does not do (no driving reports, no crash detection), and how
  SOS delivery actually works. The help beacon page explains itself to
  no-JavaScript visitors instead of rendering blank.

## [0.6.1]

- **The app is the app, not the website.** A fresh install used to open on
  the site's whole sales pitch, FAQ and all, ending in a button offering to
  download the APK you were already inside. The Android app now boots to a
  start screen that belongs to an app: logo, one line, create, join, demo,
  and a single link out to starlingmap.app for anyone who wants the long
  version. The marketing sections are removed from the DOM there, not
  hidden. The website keeps every section, exactly as before.
- Inside the app, a bare starlingmap.app link now opens in your browser
  instead of reloading the bundled page; invite and help deep links still
  open in the app.
- A new headless-Chromium suite boots the real page both ways and holds the
  split: wrapper start screen clean, website complete.

## [0.6.0]

- **Places.** Name the spots that matter, like Home or School, and Starling
  tells you when someone in your circle arrives or leaves one. Everything
  about a place lives only on your phone: detection runs on-device against
  positions that were already arriving, so the relay never learns a place
  exists, let alone where it is. Add a place from your current position or
  by tapping the map; radius is a choice, boundary jitter is absorbed
  rather than announced, and a deliberately coarse position is never used
  to judge a 250 m circle. With the app lock on, places are sealed at rest
  under the same vault key as the circle secret.
- **Alerts that reach you.** A member's SOS, an arrival at a place, or a
  circle member's phone running low now posts a real notification through
  the Android app while it is in the background. On the open web nothing
  changes, because Starling still has no push tokens to give anyone.
- **Duress passcode.** An optional second passcode for the moment someone
  makes you open the app: typed on the lock screen, it runs the full panic
  wipe and comes back up as a fresh install. Setting it to your unlock
  passcode is refused, and so is changing your passcode onto it. Storage
  can reveal that a duress code exists; watching you type cannot tell it
  from the real one. The threat model spells this out.
- **One wipe, three triggers.** The in-app panic wipe in the Android app now
  runs the same OS-level clear the PanicKit trigger always did, Keystore
  wrap key and notification channels included, instead of only clearing the
  page's own storage. The duress passcode fires that same path.
- **Clipboard hygiene.** A copied invite link clears itself from the
  clipboard after 90 seconds when the clipboard still holds exactly that
  link. Anything you copied since is left alone.
- **The landing page grew up.** How it works, a feature grid, the honesty
  table of what the relay can and cannot see, a sealed-envelope diagram,
  and answers to the questions people actually ask, all in the same
  no-external-requests budget as before.
- 517 unit tests.

## [0.5.0]

Protocol v2. This is a hard break: **a v1 client cannot talk to a v2 relay.**
Once the relay is redeployed with this release, `/api/v1/*` answers `410
Gone` instead of syncing an old client into an empty channel, because v1 and
v2 derive different channel ids from the same circle secret, so there is no
member on the other end regardless of what the relay does. Every circle that
existed before has to be re-created from a fresh invite after the relay
upgrade. If you are updating, expect this: it is the first thing you will
hit, not a bug report waiting to happen.

- **Forward secrecy.** Content keys now advance every 10 minutes and the
  previous key is destroyed on the device that advanced past it. How much
  trail stays readable is a setting: 10 minutes, 1 hour, 6 hours, or 24
  hours, worded as the trade it is rather than hidden behind a toggle.
- **Post-compromise security and cryptographic member removal**, both via
  re-keying with fresh ECDH entropy. A re-key moves the whole circle to a
  new channel with a new chain; a removed member receives no wrap, derives
  no new keys, and cannot follow. Any member may trigger a re-key, and every
  one is attributed in the UI to whoever signed it.
- **One-time invites.** A v1 invite link carried the circle's own key
  material, so anyone who ever saw the link held every past and future key.
  A v2 invite bootstraps a pairwise handshake instead: the link carries a
  commitment to the inviter's identity, the welcome is signed by the
  inviter's real circle identity, and a human compares a safety number
  before any circle key material changes hands. The invite is burned the
  moment that happens. If the welcome cannot be delivered the admission is
  undone rather than left standing, so a circle is never holding a member it
  has no way to reach, and the link stays live so the accept can be tried
  again.
- **Beacon links are now per-viewer, revocable, and actually expire.** Each
  person an SOS reaches gets an independent secret and channel; revoking one
  viewer ends only that channel. Expiry is enforced on both the beacon and
  the viewer page independently, not just displayed.
- **407 unit tests**, including a new `test/vectors/` directory: machine-readable
  HKDF, chain-advance, and session vectors an independent implementation can
  replay, checked in and exercised by `npm test` on every run rather than
  trusted to stay correct by inspection.
- Member ids, safety numbers, and every derivation in this release use the
  `starling/v2` domain-separation prefix throughout; nothing is shared with
  v1's key schedule.

## [0.4.1]

- Help links point at `/help`, which is where the site actually serves that
  page; the `.html` spelling was answered with a redirect. The service
  worker now recognises both spellings, so a helper who already has the app
  installed gets the emergency page instead of the app. The local dev server
  resolves extensionless paths the same way the host does, so this class of
  difference shows up in testing rather than in production.

## [0.4.0]

- Get help from outside your circle. An SOS can now mint a help link that
  opens your live position in any browser, with no app and no account, for
  whoever can actually reach you: the neighbour, the colleague, the friend
  three blocks away who was never in your circle. The link carries its own
  secret, its own channel, and its own signing identity, so it shows that one
  emergency and can never become access to your circle or its history.
  Checking in safe, stopping the share, or locking the app ends it and tells
  the person watching, rather than going quiet.
- Receiving devices now verify each sender's signature themselves. The
  circle's content key is shared by everyone in it, so decryption alone only
  ever proved that some member wrote a message; the signature is what says
  which member. Until now the relay was the only thing checking it, which
  meant a member working with a compromised relay could have put someone
  else's name on a position. The feed carries signatures and every device
  checks them before it decrypts anything.
- Member ids widened from 64 to 128 bits, since that id is how a key gets
  named and a receiver's whole trust in "who sent this" rests on it.
  Existing installs upgrade in place, keeping their circles, keys, and
  invite links.
- Tor mode asks Orbot which SOCKS port it is actually using instead of
  assuming the default, so a moved port works instead of failing closed for
  a reason nothing on screen could explain.
- The relay stops a member's replay window from re-opening under concurrent
  posts, and separates its rate-limit accounting so flooding new channels
  can no longer clear an address's own limit.

## [0.3.1]

- Hardening pass on the Android wrapper after an external review round. The
  panic wipe deletes the Keystore wrap key and the share notification
  channel itself before handing the rest to the system wipe, instead of
  trusting the system's own fire and forget keystore cleanup. Tor mode
  spells out SOCKS5 so hostname lookups ride through the proxy, reloads the
  page when the toggle flips so connections from the old setting get
  stranded, and takes location fixes from GPS alone while it is on, since
  the network provider works by shipping nearby wifi and cell identifiers
  to an off-device lookup. The biometric prompt zeroes its copy of the
  vault key on every exit, dismissal and error included.
- The threat model now says plainly that nothing here has had an external
  audit, and the Android notes list the Tor toggle's honest limits: the
  default port assumption, links that leave for the system browser, and
  localhost port squatting.

## [0.3.0]

- Multiple circles. Keep family, friends, and the trip as separate circles
  and switch between them from the circle name at the top of the map. Each
  circle has its own secret, its own channel, and its own signing identity,
  so the relay cannot link them. Create and join now add a circle instead of
  replacing the one you have, invites you already accepted just switch, and
  settings grows a leave option with a typed confirm. With the app lock on,
  every circle secret and name seals under the same vault key.
- The hosted website is now a landing page and demo only: it refuses to
  create or open circles, shows invite links the way to the app, and offers
  an eraser for data stored by the old web app. Sharing is app-only; the
  full app still runs on localhost for development.
- The landing and privacy policy now spell out the IP story: members never
  see each other's IPs, and Orbot routing hides yours from the relay.

## [0.2.0]

- Android app: a hand-written Kotlin WebView wrapper around the same `app/`
  code, targeting both Google Play and F-Droid. Adds background sharing
  through a foreground service with a persistent notification, fingerprint
  or face unlock through the Android Keystore in place of WebAuthn PRF, a
  PanicKit responder for panic-button apps, and Orbot support (per-app VPN
  mode with no setup, plus an in-app SOCKS toggle for Orbot's Power User
  Mode).
- Custom relay setting, on both the web app and the Android wrapper, so
  anyone can point their client at a self-hosted relay instead of the
  default one. The relay's allowed origins now include the WebView asset
  origin and an optional operator-configured list for self-hosters.
- Leaflet moved from a vendored, committed copy to a normal npm dependency
  pinned by `package-lock.json`. `tools/sync-vendor.sh` copies the
  unminified build into `app/vendor/leaflet` at build time instead of that
  directory living in git, which is also what makes the app buildable from
  source for F-Droid.

## [0.1.0]

First release.

- End to end encrypted location sharing in circles: AES-256-GCM under an
  HKDF-derived key from a 32-byte circle secret that only travels in invite-link
  fragments. Per-device Ed25519 signing (P-256 fallback) with key pinning at the
  relay. Plaintext padded to a fixed 512 bytes so ciphertext size carries
  nothing.
- Zero-knowledge relay as a Cloudflare Worker over D1. Stores ciphertext and
  pinned keys only, pages the feed on server receive time, and expires every row
  after 24 hours. Non-enumerable channels, per-channel and per-IP rate limits,
  a same-origin write check, and uniform error responses.
- Installable PWA: live map with eased markers and trails, draggable member
  sheet, SOS hold-to-fire, check-ins, battery, coarse (neighborhood) mode, a
  privacy "Off-grid" basemap that makes zero network requests, an offline demo,
  and a panic wipe.
- App lock: optional at-rest encryption of the circle secret behind a passcode
  (PBKDF2-SHA-256, 600k iterations) and, where supported, biometric unlock via
  the WebAuthn PRF extension. Off by default, auto-lock, and locked on launch.
- Invite QR codes from an in-repo byte-mode encoder, proven matrix-identical to
  the reference library across every mask.
- 153 unit tests plus two headless-browser end to end suites, one of which dumps
  the relay database and asserts no name or coordinate appears in it.
