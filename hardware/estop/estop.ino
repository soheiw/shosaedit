// ShosaEdit USB STOP button (Arduino, Raspberry Pi Pico with arduino-pico, M5Stack, ...).
//
// Wiring: a 3.5 mm mono switch jack. Tip -> BUTTON_PIN, sleeve -> GND. The pin uses
// the internal pull-up, so a normally-open switch reads LOW while pressed.
//
// Protocol on USB serial (115200 baud, one line each):
//   SHOSA-ESTOP 1     once at start (ShosaEdit only accepts a port that says this)
//   OK                every 100 ms while the button is up      (heartbeat)
//   STOP              every 100 ms while the button is down, and at once on a press
// ShosaEdit stops all motion on the first STOP. A silent port for more than 1 s is
// shown as "STOP button lost".
//
// Limit: with a normally-open switch an unplugged switch looks the same as "not
// pressed". A normally-closed switch (set NORMALLY_CLOSED to true) turns an unplugged
// or broken cable into STOP instead.

const int BUTTON_PIN = 2;           // change to the pin the jack tip is wired to
const bool NORMALLY_CLOSED = false; // true for a normally-closed (break-to-stop) switch
const unsigned long HEARTBEAT_MS = 100;
const unsigned long DEBOUNCE_MS = 5;

bool lastPressed = false;
unsigned long lastSend = 0;
unsigned long changedAt = 0;

bool readPressed() {
  bool low = digitalRead(BUTTON_PIN) == LOW;   // contact closed pulls the pin to GND
  return NORMALLY_CLOSED ? !low : low;
}

void setup() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
  delay(200);
  Serial.println("SHOSA-ESTOP 1");
}

void loop() {
  unsigned long now = millis();
  bool pressed = readPressed();
  if (pressed != lastPressed && now - changedAt >= DEBOUNCE_MS) {
    changedAt = now;
    lastPressed = pressed;
    if (pressed) {
      Serial.println("STOP");       // send the press at once, not on the next beat
      lastSend = now;
    }
  }
  if (now - lastSend >= HEARTBEAT_MS) {
    Serial.println(lastPressed ? "STOP" : "OK");
    lastSend = now;
  }
  digitalWrite(LED_BUILTIN, lastPressed ? HIGH : LOW);
}
