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
bool runSequence();

const unsigned long PAPER_REACH_TIMEOUT_MS = 3000;
const unsigned long PRE_FEED_CLEAR_TIMEOUT_MS = 30000;
const unsigned long POST_CLEAR_DELAY_MS = 1000;
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

// transfer: roll toward the scanner until the scanner sensor sees the sheet,
// then push it a fixed extra amount into the scanner's intake
const int TRANSFER_PWM = 200;
const unsigned long TRANSFER_TIMEOUT_MS = 3000;
const int HANDOFF_PUSH_PWM = 255;
const unsigned long HANDOFF_PUSH_MS = 500;

bool jamAlarmActive = false;
bool jamAlarmToneOn = false;
unsigned long jamAlarmLastToggleAt = 0;

// change this if your sensor is inverted
bool isScannerPaperDetected() {
  return digitalRead(scannerSensor) == HIGH;
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
  if (command == "FEED" || command == "g") {
    feedOneSheet();
  } else if (command == "STOP") {
    stopMotor();
    Serial.println("FEED_CANCELLED");
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

    if (!runSequence()) {
      finishFeed("FEED_CANCELLED");
      return;
    }
    stopMotor();

    if (waitForScannerPaperState(true, PAPER_REACH_TIMEOUT_MS)) {
      Serial.println("SCANNER_SENSOR_DETECTED");
      finishFeed("SHEET_FED");
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

bool runSequence() {
  // Feed IN
  if (!driveMotor(true, 255, FEED_IN_HOLD_MS)) return false;

  // brake
  analogWrite(ENA, 0);
  if (!delayWithStop(500)) return false;

  // transfer to scanner: one continuous roll (no mid-way stop) until the
  // scanner sensor sees the sheet, then a fixed push from that point so the
  // hand-off is the same whether the sheet was picked up early or late
  if (!driveMotor(false, TRANSFER_PWM, 0)) return false;

  unsigned long transferStartedAt = millis();
  bool reached = false;
  while (millis() - transferStartedAt < TRANSFER_TIMEOUT_MS) {
    if (isScannerPaperDetected()) {
      reached = true;
      break;
    }
    if (!delayWithStop(SENSOR_POLL_MS)) return false;
  }

  if (reached) {
    Serial.print("TRANSFER_MS:");
    Serial.println(millis() - transferStartedAt);
    analogWrite(ENA, HANDOFF_PUSH_PWM);
    if (!delayWithStop(HANDOFF_PUSH_MS)) return false;
  }

  stopMotor();
  return true;
}
