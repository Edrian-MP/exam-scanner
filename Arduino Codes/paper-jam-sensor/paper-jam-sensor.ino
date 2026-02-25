const int encoderPin = 10;   // paper jam sensor
const int ledPin = LED_BUILTIN;

int lastState = -1;

int ENA = 9;   // PWM pin
int IN1 = 8;
int IN2 = 7;

String input = "";
bool autoRun = false;

// change this if your sensor is inverted
bool isPaperDetected() {
  return digitalRead(encoderPin) == HIGH;
}

void stopMotor() {
  analogWrite(ENA, 0);
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(ledPin, LOW);
}

void setup() {
  pinMode(ledPin, OUTPUT);
  pinMode(encoderPin, INPUT);

  pinMode(ENA, OUTPUT);
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);

  Serial.begin(9600);
  Serial.println("Type 'g' to start...");

  stopMotor();
}

void loop() {
  int currentState = digitalRead(encoderPin);

  if (currentState != lastState) {
    Serial.print("Sensor state: ");
    Serial.println(currentState);
    lastState = currentState;
  }

  // Start auto cycle only once after first 'g'
  if (Serial.available()) {
    input = Serial.readStringUntil('\n');
    input.trim();

    if (input == "g") {
      autoRun = true;
      Serial.println("Auto cycle started.");
    }
  }

  if (autoRun) {
    Serial.println("Running...");
    runSequence();
    Serial.println("Stopped.");

    // sensor only matters after the sequence
    Serial.println("Waiting for paper to reach sensor...");
    while (!isPaperDetected()) {
      delay(10);
    }

    Serial.println("Paper reached sensor. Waiting for sensor to clear...");
    while (isPaperDetected()) {
      delay(10);
    }

    Serial.println("Sensor cleared. Waiting 2 seconds before next run...");
    delay(2000);
  }
}

void runSequence() {
  // Feed IN
  digitalWrite(LED_BUILTIN, HIGH);
  digitalWrite(IN1, HIGH);
  digitalWrite(IN2, LOW);
  analogWrite(ENA, 255);
  digitalWrite(LED_BUILTIN, LOW);
  delay(650);

  // brake
  analogWrite(ENA, 0);
  delay(500);

  // feed out
  digitalWrite(LED_BUILTIN, HIGH);
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);
  analogWrite(ENA, 200);
  delay(500);

  digitalWrite(LED_BUILTIN, HIGH);
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);
  analogWrite(ENA, 200);
  delay(900);

  analogWrite(ENA, 0);
  delay(500);

  // after push
  digitalWrite(LED_BUILTIN, HIGH);
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);
  analogWrite(ENA, 255);
  delay(100);

  // brake
  analogWrite(ENA, 0);
  delay(1000);

  stopMotor();
}