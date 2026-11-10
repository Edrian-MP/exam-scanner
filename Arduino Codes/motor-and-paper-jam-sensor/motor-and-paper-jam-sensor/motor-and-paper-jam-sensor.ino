const int scannerSensor = 10;   // near-scanner paper sensor
const int traySensor = 12;      // tray paper-presence sensor
const int ledPin = LED_BUILTIN;
const int BUZZER_PIN = 11;   // active buzzer signal pin

int lastScannerState = -1;
int lastTrayState = -1;

int ENA = 9;   // PWM pin
int IN1 = 8;
int IN2 = 7;

String serialBuffer = "";
bool feedCancelled = false;

bool readSerialLine(String &line);
void handleIdleCommand(String command);
void reportSensorChanges();
bool consumeStopCommand();
bool delayWithStop(unsigned long durationMs);
void finishFeed(const char *status);
bool runSequence(int attempt, bool &reached);
bool tapPush(int count);

const unsigned long PAPER_REACH_TIMEOUT_MS = 3000;
const unsigned long PRE_FEED_CLEAR_TIMEOUT_MS = 30000;
const unsigned long POST_CLEAR_DELAY_MS = 500;  // pause after the scanner slot clears (was 1000)
const unsigned long BRAKE_MS = 250;             // pause before reversing toward the scanner (was 500)
const unsigned long SENSOR_POLL_MS = 10;
const unsigned long LONG_BEEP_MS = 500;
const unsigned long SHORT_BEEP_MS = 150;
const unsigned long BEEP_GAP_MS = 150;
const unsigned long JAM_ALARM_ON_MS = 800;
const unsigned long JAM_ALARM_OFF_MS = 350;
const int MAX_FEED_ATTEMPTS = 3;

// soft start: ramp PWM up gradually so the roller grips instead of slipping.
// The ramp starts above the motor's stall point so the roller is already
// turning (and pulling the sheet) from the first moment of the feed.
const int SOFT_START_MIN_PWM = 150;
const unsigned long SOFT_START_MS = 150;
const unsigned long FEED_IN_HOLD_MS = 800;
const unsigned long FEED_IN_RETRY_EXTRA_MS = 300;

// transfer: one roll toward the scanner at full speed. When the scanner sensor
// sees the sheet, push at HANDOFF_PWM for HANDOFF_MS, then tap it
// HANDOFF_TAPS times to seat it in the scanner's rollers.
const int TRANSFER_PWM = 255;  // full power: the sheet was landing short at 220
const unsigned long TRANSFER_TIMEOUT_MS = 3000;  // sheets normally arrive in ~0.8-1 s
const int HANDOFF_PWM = 255;  // landscape needs full power (portrait used 200)
// 1200 and 1800 left the sheet at the same spot: past ~1 s the roller no longer
// moves the sheet with a steady push (it slips), so the rest of the hand-off is
// done with taps instead
const unsigned long HANDOFF_MS = 1000;
const unsigned long EASE_OFF_MS = 150;

// taps: short full-power bursts with a pause between them. A roller that slips
// under a steady push re-grips the paper each time it starts, so taps can move a
// sheet the last few millimetres into the scanner where a longer push can't.
const int HANDOFF_TAPS = 4;          // taps at the end of every hand-off (landscape needs 4; portrait used 0)
const int PUSH_DEFAULT_TAPS = 5;     // taps for the PUSH command
const int PUSH_MAX_TAPS = 12;
const unsigned long TAP_ON_MS = 150;
const unsigned long TAP_OFF_MS = 120;

// assist: in portrait the sheet's tail is still under the feeder roller when
// the scanner grabs the front. A stopped roller (held by the gearbox) pinches
// the tail, so after SHEET_FED the roller is kept turning toward the scanner at
// ASSIST_PWM — below the motor's stall point, so it can't push the sheet on its
// own, but enough to cancel the drag while the scanner pulls it through. It
// switches off once the scanner sensor has been clear for ASSIST_CLEAR_MS (the
// tail has passed), after ASSIST_TIMEOUT_MS, or on any new command.
// Off for landscape: the sheet leaves the roller before the scanner grabs it,
// so there's no tail to pinch. Set true again for portrait feed.
const bool ASSIST_ENABLED = false;
const int ASSIST_PWM = 100;                    // must stay below the stall point (< SOFT_START_MIN_PWM)
const unsigned long ASSIST_TIMEOUT_MS = 15000;
const unsigned long ASSIST_CLEAR_MS = 300;
bool assistActive = false;
unsigned long assistStartedAt = 0;
unsigned long assistClearSince = 0;
bool assistSawClear = false;

bool jamAlarmActive = false;
bool jamAlarmToneOn = false;
unsigned long jamAlarmLastToggleAt = 0;

// Debounced scanner sensor: a change only counts once it has held for
// SENSOR_DEBOUNCE_MS, so the flicker as the sheet edge passes is ignored.
const unsigned long SENSOR_DEBOUNCE_MS = 40;
bool scannerStable = false;
bool scannerRaw = false;
unsigned long scannerRawSince = 0;

// change this if your sensor is inverted
bool isScannerPaperDetected() {
  return digitalRead(scannerSensor) == HIGH;
}

void resetScannerDebounce() {
  scannerRaw = scannerStable = isScannerPaperDetected();
  scannerRawSince = millis();
}

bool readScannerDebounced() {
  bool raw = isScannerPaperDetected();
  unsigned long now = millis();
  if (raw != scannerRaw) {
    scannerRaw = raw;
    scannerRawSince = now;
  } else if (raw != scannerStable && now - scannerRawSince >= SENSOR_DEBOUNCE_MS) {
    scannerStable = raw;
  }
  return scannerStable;
}

bool isTrayPaperDetected() {
  return digitalRead(traySensor) == HIGH;
}

void stopMotor() {
  analogWrite(ENA, 0);
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(ledPin, LOW);
}

void startAssist() {
  if (!ASSIST_ENABLED) {
    return;
  }
  digitalWrite(IN1, LOW);   // toward the scanner, same as the transfer
  digitalWrite(IN2, HIGH);
  analogWrite(ENA, ASSIST_PWM);
  assistActive = true;
  assistStartedAt = millis();
  assistSawClear = false;
  Serial.println("ASSIST_ON");
}

void stopAssist(const char *reason) {
  if (!assistActive) {
    return;
  }
  assistActive = false;
  stopMotor();
  Serial.print("ASSIST_OFF:");
  Serial.println(reason);
}

void updateAssist() {
  if (!assistActive) {
    return;
  }
  unsigned long now = millis();
  if (isScannerPaperDetected()) {
    assistSawClear = false;
  } else if (!assistSawClear) {
    assistSawClear = true;
    assistClearSince = now;
  } else if (now - assistClearSince >= ASSIST_CLEAR_MS) {
    stopAssist("CLEAR");
    return;
  }
  if (now - assistStartedAt >= ASSIST_TIMEOUT_MS) {
    stopAssist("TIMEOUT");
  }
}

void buzzerOn() {
  digitalWrite(BUZZER_PIN, HIGH);
}

void buzzerOff() {
  digitalWrite(BUZZER_PIN, LOW);
}

void beepLongOnce() {
  buzzerOn();
  delay(LONG_BEEP_MS);
  buzzerOff();
}

void beepShortPattern(int count) {
  for (int i = 0; i < count; i++) {
    buzzerOn();
    delay(SHORT_BEEP_MS);
    buzzerOff();
    if (i < count - 1) {
      delay(BEEP_GAP_MS);
    }
  }
}

void startJamAlarm() {
  jamAlarmActive = true;
  jamAlarmToneOn = true;
  jamAlarmLastToggleAt = millis();
  buzzerOn();
}

void stopJamAlarm() {
  jamAlarmActive = false;
  jamAlarmToneOn = false;
  buzzerOff();
}

void stopJamAlarmIfSensorClear() {
  if (jamAlarmActive && !isScannerPaperDetected()) {
    stopJamAlarm();
  }
}

void updateJamAlarm() {
  if (!jamAlarmActive) {
    return;
  }

  stopJamAlarmIfSensorClear();
  if (!jamAlarmActive) {
    return;
  }

  unsigned long now = millis();
  unsigned long interval = jamAlarmToneOn ? JAM_ALARM_ON_MS : JAM_ALARM_OFF_MS;
  if (now - jamAlarmLastToggleAt >= interval) {
    jamAlarmToneOn = !jamAlarmToneOn;
    jamAlarmLastToggleAt = now;
    if (jamAlarmToneOn) {
      buzzerOn();
    } else {
      buzzerOff();
    }
  }
}

bool waitForScannerPaperState(bool targetState, unsigned long timeoutMs) {
  unsigned long startedAt = millis();

  while (isScannerPaperDetected() != targetState) {
    updateJamAlarm();
    reportSensorChanges();
    if (consumeStopCommand()) {
      return false;
    }
    if (millis() - startedAt >= timeoutMs) {
      return false;
    }
    delay(SENSOR_POLL_MS);
  }

  return true;
}

void setup() {
  pinMode(ledPin, OUTPUT);
  pinMode(scannerSensor, INPUT);
  pinMode(traySensor, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);

  pinMode(ENA, OUTPUT);
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);

  Serial.begin(9600);
  Serial.println("READY");

  stopMotor();
  buzzerOff();
}

void loop() {
  updateAssist();
  updateJamAlarm();
  reportSensorChanges();

  String command;
  if (readSerialLine(command)) {
    handleIdleCommand(command);
  }
}

bool readSerialLine(String &line) {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\r') {
      continue;
    }
    if (c == '\n') {
      line = serialBuffer;
      line.trim();
      serialBuffer = "";
      return line.length() > 0;
    }
    if (serialBuffer.length() < 64) {
      serialBuffer += c;
    }
  }
  return false;
}

void handleIdleCommand(String command) {
  // any motor command takes over the roller from the assist
  if (!command.startsWith("BEEP_")) {
    stopAssist("CMD");
  }
  if (command == "FEED" || command == "g") {
    feedOneSheet();
  } else if (command == "STOP") {
    stopMotor();
    Serial.println("FEED_CANCELLED");
  } else if (command.startsWith("JOG:")) {
    // bench tuning: JOG:<F|R>:<pwm>:<ms>, e.g. JOG:F:255:800
    int c1 = command.indexOf(':', 4);
    int c2 = command.indexOf(':', c1 + 1);
    if (c1 < 0 || c2 < 0) {
      Serial.println("JOG_BAD");
      return;
    }
    bool forward = command.charAt(4) == 'F';
    digitalWrite(IN1, forward ? HIGH : LOW);
    digitalWrite(IN2, forward ? LOW : HIGH);
    analogWrite(ENA, constrain(command.substring(c1 + 1, c2).toInt(), 0, 255));
    delayWithStop(command.substring(c2 + 1).toInt());
    stopMotor();
    Serial.println("JOG_DONE");
  } else if (command == "PUSH" || command.startsWith("PUSH:")) {
    // tap a sheet that stopped short the rest of the way into the scanner;
    // PUSH:<taps>, sent by the scanner service when the scanner sees no paper
    int taps = PUSH_DEFAULT_TAPS;
    if (command.length() > 5) {
      taps = constrain(command.substring(5).toInt(), 1, PUSH_MAX_TAPS);
    }
    bool pushed = tapPush(taps);
    stopMotor();
    Serial.println("PUSH_DONE");
    if (pushed) {
      startAssist();  // tail is still under the roller: keep easing it through
    }
  } else if (command == "BEEP_START") {
    beepLongOnce();
  } else if (command == "BEEP_FINISH") {
    beepShortPattern(3);
  } else if (command == "BEEP_CANCEL_FAILURES") {
    beepShortPattern(5);
  }
}

void reportSensorChanges() {
  int currentScannerState = digitalRead(scannerSensor);
  int currentTrayState = digitalRead(traySensor);

  if (currentScannerState != lastScannerState) {
    Serial.print("scannerSensor state: ");
    Serial.println(currentScannerState);
    lastScannerState = currentScannerState;
  }

  if (currentTrayState != lastTrayState) {
    Serial.print("traySensor state: ");
    Serial.println(currentTrayState);
    lastTrayState = currentTrayState;
  }
}

bool consumeStopCommand() {
  String command;
  while (readSerialLine(command)) {
    if (command == "STOP") {
      feedCancelled = true;
      stopMotor();
      return true;
    }
  }
  return false;
}

bool delayWithStop(unsigned long durationMs) {
  unsigned long startedAt = millis();

  while (millis() - startedAt < durationMs) {
    updateJamAlarm();
    reportSensorChanges();
    if (consumeStopCommand()) {
      return false;
    }
    delay(SENSOR_POLL_MS);
  }

  return true;
}

void finishFeed(const char *status) {
  stopMotor();
  Serial.println(status);
  feedCancelled = false;
}

void feedOneSheet() {
  feedCancelled = false;
  Serial.println("FEED_STARTED");

  if (!isTrayPaperDetected()) {
    finishFeed("NO_PAPER");
    return;
  }

  if (!waitForScannerPaperState(false, PRE_FEED_CLEAR_TIMEOUT_MS)) {
    if (feedCancelled) {
      finishFeed("FEED_CANCELLED");
      return;
    }
    stopMotor();
    startJamAlarm();
    finishFeed("PAPER_JAM");
    return;
  }

  if (!delayWithStop(POST_CLEAR_DELAY_MS)) {
    finishFeed("FEED_CANCELLED");
    return;
  }

  for (int attempt = 1; attempt <= MAX_FEED_ATTEMPTS; attempt++) {
    Serial.print("FEED_ATTEMPT:");
    Serial.println(attempt);

    bool reached = false;
    if (!runSequence(attempt, reached)) {
      finishFeed("FEED_CANCELLED");
      return;
    }
    stopMotor();

    // a sheet seen during the transfer is at the scanner slot even if it then
    // lifts off the sensor; retrying would pull it back, so report it fed
    if (reached || waitForScannerPaperState(true, PAPER_REACH_TIMEOUT_MS)) {
      Serial.println("SCANNER_SENSOR_DETECTED");
      finishFeed("SHEET_FED");
      startAssist();  // let the scanner pull the tail out of the roller
      return;
    }
    if (feedCancelled) {
      finishFeed("FEED_CANCELLED");
      return;
    }
  }

  stopMotor();
  startJamAlarm();
  finishFeed("PAPER_JAM");
}

// Set direction, ramp PWM up to targetPwm, then hold it for holdMs.
bool driveMotor(bool forward, int targetPwm, unsigned long holdMs) {
  digitalWrite(LED_BUILTIN, HIGH);
  digitalWrite(IN1, forward ? HIGH : LOW);
  digitalWrite(IN2, forward ? LOW : HIGH);

  // time the ramp with millis() so it lasts SOFT_START_MS regardless of the
  // extra time spent polling sensors/serial between steps
  unsigned long rampStartedAt = millis();
  unsigned long elapsed;
  while ((elapsed = millis() - rampStartedAt) < SOFT_START_MS) {
    int pwm = SOFT_START_MIN_PWM + (long)(targetPwm - SOFT_START_MIN_PWM) * elapsed / SOFT_START_MS;
    analogWrite(ENA, pwm);
    updateJamAlarm();
    reportSensorChanges();
    if (consumeStopCommand()) return false;
    delay(5);
  }

  analogWrite(ENA, targetPwm);
  return delayWithStop(holdMs);
}

// Returns false only if cancelled; `reached` reports whether the scanner
// sensor saw the sheet during the transfer.
bool runSequence(int attempt, bool &reached) {
  // Feed IN: a failed attempt usually means the sheet wasn't pulled in far
  // enough, so each retry pulls a little longer
  unsigned long feedInMs = FEED_IN_HOLD_MS + (attempt - 1) * FEED_IN_RETRY_EXTRA_MS;
  if (!driveMotor(true, 255, feedInMs)) return false;

  // brake
  analogWrite(ENA, 0);
  if (!delayWithStop(BRAKE_MS)) return false;

  // transfer to scanner: one smooth roll at a steady speed until the scanner
  // sensor sees the sheet, then the same speed for HANDOFF_MS to carry it
  // into the slot, so the hand-off is the same whether it arrived early or late
  if (!driveMotor(false, TRANSFER_PWM, 0)) return false;

  unsigned long transferStartedAt = millis();
  reached = false;
  resetScannerDebounce();
  while (millis() - transferStartedAt < TRANSFER_TIMEOUT_MS) {
    if (readScannerDebounced()) {
      reached = true;
      break;
    }
    if (!delayWithStop(SENSOR_POLL_MS)) return false;
  }

  int endPwm = TRANSFER_PWM;
  if (reached) {
    Serial.print("TRANSFER_MS:");
    Serial.println(millis() - transferStartedAt);
    // Push the sheet into the scanner's intake at full power for a fixed time
    // from the moment it was detected. Don't stop early when the sensor loses
    // the sheet: the leading edge moving past the sensor (or a slight lift) is
    // normal, and stopping there left the sheet short of the scanner rollers.
    analogWrite(ENA, HANDOFF_PWM);
    endPwm = HANDOFF_PWM;
    if (!delayWithStop(HANDOFF_MS)) return false;
    // then tap it the last bit into the scanner, if taps are enabled
    if (HANDOFF_TAPS > 0) {
      if (!tapPush(HANDOFF_TAPS)) return false;
      stopMotor();
      return true;
    }
  }

  // ease off instead of stopping dead so the sheet isn't jolted
  unsigned long easeStartedAt = millis();
  unsigned long elapsed;
  while ((elapsed = millis() - easeStartedAt) < EASE_OFF_MS) {
    analogWrite(ENA, endPwm - (long)endPwm * elapsed / EASE_OFF_MS);
    if (!delayWithStop(5)) return false;
  }

  stopMotor();
  return true;
}

// Tap the sheet toward the scanner: `count` short full-power bursts. Returns
// false only if cancelled.
bool tapPush(int count) {
  digitalWrite(LED_BUILTIN, HIGH);
  digitalWrite(IN1, LOW);   // same direction as the transfer (driveMotor(false, ...))
  digitalWrite(IN2, HIGH);
  for (int i = 0; i < count; i++) {
    analogWrite(ENA, HANDOFF_PWM);
    if (!delayWithStop(TAP_ON_MS)) return false;
    analogWrite(ENA, 0);
    if (!delayWithStop(TAP_OFF_MS)) return false;
  }
  return true;
}
