# EPG time correction

TuxPlayerX supports XMLTV EPG sources. XMLTV programmes can include timezone offsets such as `+0200` or `+0300` in the `start` and `stop` attributes.

The app now provides three modes in **Settings → EPG time correction**:

- **Auto / XMLTV timezone**: reads the timezone offset from XMLTV when present and displays programme times in the computer's local timezone. Use this first.
- **Treat EPG times as local time**: ignores XMLTV timezone offsets and treats the raw programme time as local time.
- **Manual offset**: starts from Auto mode, then applies an additional offset in minutes. Use this when an EPG source is consistently shifted.

Examples:

- If programmes appear 1 hour too late, set Manual offset to `-60`.
- If programmes appear 1 hour too early, set Manual offset to `+60`.
- If the EPG source is correct, keep Auto and offset `0`.


## Default Romanian EPG source

TuxPlayerX now pre-fills the EPG field with:

```text
https://iptv-epg.org/files/epg-ro.xml
```

The value is only a default. Users can change it at any time from **Settings → EPG / XMLTV URL**.
