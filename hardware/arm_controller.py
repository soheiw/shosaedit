# Copied from B2J_rehersal's TouchDesigner controller (embody_robot_arm_controller.py,
# 2026-11-26) so ShosaEdit can drive the arms without TouchDesigner. Changes from
# that file: Recorded_movements lives under DATA_DIR, the idle position read
# also returns register 126 (Present Current / Present Load), and CONNECT writes
# the operating mode only to motors not already in extended position mode. Keep the two in
# step when a safety fix lands in one of them.
import time
import os
import csv
import sys
import queue
import threading
import logging
import collections
from dynamixel_sdk import *

# TD re-imports this module every time the file changes. Anything that must
# outlive a reload (open arms, their states, the log buffer) lives in this
# registry, so an edit never orphans an open COM port and its threads.
_registry = sys.__dict__.setdefault('_shosaedit_robot_arm_registry', {})
_registry['generation'] = _registry.get('generation', 0) + 1
_GENERATION = _registry['generation']

# Worker threads must never write to TD's textport (it can crash TD), so log
# records go into a bounded buffer that drain_log() prints on the main thread.
_log_lines = _registry.setdefault('log_lines', collections.deque(maxlen=500))
# The same lines, kept after printing, so a session can be reviewed later.
_log_history = _registry.setdefault('log_history', collections.deque(maxlen=1000))

class _BufferHandler(logging.Handler):
	def emit(self, record):
		try:
			line = self.format(record)
			_log_lines.append(line)
			_log_history.append(line)
		except Exception:
			pass

log = logging.getLogger('robot_arm')
log.setLevel(logging.INFO)
log.propagate = False
for _old_handler in list(log.handlers):
	log.removeHandler(_old_handler)
_buffer_handler = _BufferHandler()
_buffer_handler.setFormatter(logging.Formatter('%(asctime)s [%(levelname)s] %(message)s', '%H:%M:%S'))
log.addHandler(_buffer_handler)

def drain_log(max_lines=20):
	"""Print buffered log lines to the textport. Call from TD's main thread only."""
	for _ in range(min(max_lines, len(_log_lines))):
		try:
			print(_log_lines.popleft())
		except IndexError:
			break

# Idle position reads per second while a panel shows live positions (normally
# 5). During playback and recording the shown values come from those threads,
# which already update every frame, so this costs no extra bus time there.
LIVE_VIEW_HZ = 30

# Turn torque off (arms go limp) when a playback reaches its last frame.
AUTO_RELEASE_AFTER_PLAYBACK = True

# Upper bounds on every wait, so nothing can hang a thread forever.
TASK_WAIT_TIMEOUT = 5.0    # seconds to wait for a running task before skipping an arm
START_WAIT_TIMEOUT = 3.0   # seconds a playback thread waits for the synced start

# Playback safety. Sending missed frames at full speed after a stall throws the
# arm forward (field incident 2026-11-04: COM15 froze for 21.8 s, then flushed
# its backlog). So a stall ends the playback on EVERY arm and they hold their
# last goal. Healthy runs measured up to 135 ms late, so 150 ms catches a stall
# while allowing at most ~4 frames of normal catch-up.
MAX_FRAME_LATE = 0.15        # seconds a frame may be late before playback is stopped

# ShosaEdit: read Present Current and Position during playback too. After a frame
# is sent, read once every PLAYBACK_READ_EVERY frames, and only when at least
# PLAYBACK_READ_SLACK seconds remain before the next frame is due, so a read never
# delays a motion frame. Read times are logged at the end of each playback.
PLAYBACK_READ_EVERY = 3        # 30 fps / 3 = about 10 reads a second (0 = off)
# A read sent right after the goal sync write is lost: the motors are still taking the
# write (measured 2026-11-26: 2/60 replies with no gap, 60/60 with 1 ms, ~17 ms each).
PLAYBACK_READ_GAP = 0.002
PLAYBACK_READ_SLACK = 0.027        # gap + one read (15-24 ms on this Mac, FTDI latency timer)
PLAYBACK_STALL_LIMIT = 0.25  # seconds with no frame sent before the watchdog stops everything
MAX_FAILED_FRAMES = 5        # frames in a row the bus may refuse (~165 ms of lost motion)
SERIAL_WRITE_TIMEOUT = 0.1   # pyserial's default never times out, and a stuck write holds the bus

# Starting a recording. Frame 0 used to be sent straight away at the 60 ms
# playback profile, so an arm that was elsewhere snapped to it. Now every arm
# glides there first, on the same number of frames so they stay in step.
START_TOLERANCE = 40         # counts from frame 0 that need no lead-in (recordings step up to ~65 per frame)
LEAD_IN_COUNTS_PER_S = 400   # average lead-in speed of the farthest motor (~35 degrees/s; 4096 counts = 360)
MIN_LEAD_IN_FRAMES = 15      # shortest lead-in, half a second at 30 fps
MAX_START_DISTANCE = 2048    # half a turn: further means a wrong arm model or lost turn count, so refuse

# All serial-port work requested from TD runs on this one command thread, in
# the order it was asked for, so TD's main thread never waits on the bus.
_commands = queue.Queue()

def _command_worker(generation):
	# Exits once a newer copy of this module has been imported.
	while _registry.get('generation') == generation:
		try:
			label, fn, args = _commands.get(timeout=0.5)
		except queue.Empty:
			continue
		try:
			fn(*args)
		except Exception as e:
			log.exception(f"{label} failed: {e}")

def _submit(label, fn, *args):
	"""Queue serial-port work for the command thread and return immediately."""
	_commands.put((label, fn, args))

threading.Thread(target=_command_worker, args=(_GENERATION,), daemon=True,
				 name=f"robot_arm_commands_{_GENERATION}").start()

def _signed32(value):
	"""Present Position is a signed 32-bit value the SDK hands back unsigned."""
	value = int(value)
	return value - (1 << 32) if value >= (1 << 31) else value

def _lead_in_rows(start, target, frames):
	"""Frames easing from start to target (exclusive of start, ending on target), slow at both ends."""
	rows = []
	for n in range(1, frames + 1):
		t = n / frames
		eased = t * t * (3.0 - 2.0 * t)
		rows.append([int(round(a + (b - a) * eased)) for a, b in zip(start, target)])
	return rows

def _read_first_row(filepath):
	"""First frame of a recording as signed ints, or None if the file has no usable first row."""
	with open(filepath, mode='r') as file:
		for row in csv.reader(file):
			return [_signed32(value) for value in row]
	return None

def _resample(samples, rate):
	"""Linearly interpolate (time, [positions]) samples onto an even grid at rate Hz."""
	if not samples:
		return []
	if len(samples) == 1:
		return [samples[0][1]]
	t0 = samples[0][0]
	duration = samples[-1][0] - t0
	frames = []
	k = 0
	for n in range(int(duration * rate) + 1):
		t = t0 + n / rate
		while k < len(samples) - 2 and samples[k + 1][0] < t:
			k += 1
		(ta, a), (tb, b) = samples[k], samples[k + 1]
		f = 0.0 if tb <= ta else min(max((t - ta) / (tb - ta), 0.0), 1.0)
		frames.append([int(round(va + (vb - va) * f)) for va, vb in zip(a, b)])
	return frames

# Recordings live in Recorded_movements/<Windows COM name> on every machine, so a
# Mac port maps back to the COM name of the same arm.
RECORDING_FOLDERS = {
	'/dev/cu.usbserial-FTAK89K4': 'COM14',   # left arm
	'/dev/cu.usbserial-FTAK89O2': 'COM15',   # right arm
}

def recording_folder(port):
	"""The Recorded_movements subfolder for this arm's port."""
	return RECORDING_FOLDERS.get(port, port)

# The folder that holds Recorded_movements (the B2J_rehersal project folder).
# hardware/arm_service.py sets it at startup; TD used its own working folder.
DATA_DIR = os.getcwd()

def recordings_root():
	"""Recorded_movements under DATA_DIR."""
	return os.path.join(DATA_DIR, "Recorded_movements")


class RoboticArm:
	# 电机控制常量
	TORQUE_ENABLE = 1
	TORQUE_DISABLE = 0
	PROTOCOL_VERSION = 2.0
	BAUDRATE = 1000000
	ADDR_PRO_TORQUE_ENABLE = 64
	ADDR_PRO_PRESENT_POSITION = 132
	ADDR_PRO_PRESENT_POSITION_LEN = 4
	ADDR_PRO_PRESENT_CURRENT = 126
	PRESENT_BLOCK_LEN = 10      # 126 current (2) + 128 velocity (4) + 132 position (4)
	ADDR_PRO_GOAL_POSITION = 116
	ADDR_PRO_GOAL_POSITION_LEN = 4
	ADDR_PRO_PROFILE_ACCELERATION = 108
	ADDR_PRO_PROFILE_ACCELERATION_LEN = 4
	ADDR_PRO_PROFILE_VELOCITY = 112
	ADDR_PRO_PROFILE_VELOCITY_LEN = 4
	OP_MODE_ADDR = 11
	EXTENDED_POSITION_CONTROL_MODE = 4
	ADDR_PRO_HARDWARE_ERROR_STATUS = 70  # 硬件错误状态地址
	ADDR_DRIVE_MODE = 10
	DRIVE_MODE_TIME_BASED = 0x04   # bit 2: profiles are given in milliseconds
	# Time-based motion profile, applied on connect: each goal is reached along a
	# smooth ease-in/ease-out curve over PROFILE_TIME_MS instead of at full speed.
	# Longer = smoother but later; both arms get the same delay, so they stay in
	# sync. Acceleration time must be at most half the profile time.
	PROFILE_TIME_MS = 60
	PROFILE_ACCEL_MS = 20
	# Torque Enable (64) through Hardware Error Status (70), read in one go.
	STATUS_BLOCK_LEN = ADDR_PRO_HARDWARE_ERROR_STATUS - ADDR_PRO_TORQUE_ENABLE + 1
	MAX_POSITION = 50000
	MIN_POSITION = 0

	# Communication-result constants
	COMM_SUCCESS = 0
	COMM_TX_FAIL = -1001
	COMM_RX_TIMEOUT = -1000

	# 过载检测常量
	POSITION_THRESHOLD = 2000  # 可根据需要调整
	OVERLOAD_TIMEOUT = 1    # 秒
	
	#SPLINE ARMS
	LIGHT_FINGER_DXL_ID = 10
	ADDR_INDIRECT_DATA1 = 224

	def __init__(self, device_name, dxl_ids, is_admin=False):
		self.device_name = device_name
		self.dxl_ids = dxl_ids
		self.portHandler = PortHandler(self.device_name)
		self.packetHandler = PacketHandler(self.PROTOCOL_VERSION)
		self.file = None
		self.recording = False
		self.is_stop = False
		self.condition = threading.Condition()
		self.is_admin = is_admin
		self.task_running = False
		self.current_positions = {}
		self.present_currents = {}      # id -> (signed raw register 126, epoch seconds read)
		self.present_positions = {}     # id -> measured position from the in-playback reads
		self.read_skip_ids = set()      # IDs left out of sync reads (two motors answer to them)
		self.lock = threading.RLock()
		# All Dynamixel SDK traffic must pass through bus_action().
		# This prevents multiple threads from hammering the half-duplex bus.
		self.bus_lock = threading.RLock()
		self.min_bus_interval = 0.001  # default spacing for non-motion SDK transactions
		self.last_bus_time = 0.0
		self.bus_retries = 1
		self.bus_retry_delay = 0.008
		self._last_bus_error_log = {}
		self.task_done_event = threading.Event()
		self.task_done_event.set()
		self.port_is_open = False
		self.overload_timers = {dxl_id: 0 for dxl_id in self.dxl_ids}
		self.torque_enabled = {}  # 电机力矩状态缓存
		self.faulty_motors = []   # 记录有故障的电机
		self.stop_event = threading.Event()  # 用于控制线程停止
		self.default_speed = 300     # Default Profile Velocity / Acceleration
		self.realtime_hz = 5
		# During playback, writes have priority. Position reads are low-priority
		# and intentionally slower so they do not make animation frames late.
		self.realtime_hz_during_motion = 2
		self.realtime_thread = None
		self.realtime_thread_stop_event = threading.Event()
		self.connection_alive = False
		self.connection_fail_count = 0
		self.last_comm_time = 0
		# Per motor: 'ok', 'torque_off' (shut itself off), 'error' (hardware
		# error), 'released' (torque off on purpose) or 'no_reply'.
		self.motor_status = {}
		# Motors come up limp, so torque-off reads as 'released' (not a fault)
		# until something turns torque on.
		self.released = True
		self.status_hz = 1.0
		self._last_status_read = 0.0
		self.last_read_time = 0.0       # when positions were last read successfully
		self.time_profile_ids = []      # motors running the time-based profile
		self.custom_profile_ids = set() # motors a gesture slowed down; playback restores them
		self.live_view = False          # a panel is showing live positions: read faster
		self.has_light = None           # finger light on ID 10: None = not tried yet, False = did not answer


	def _comm_ok(self, result):
		"""Return True when a Dynamixel SDK result indicates success."""
		if isinstance(result, int):
			return result == self.COMM_SUCCESS

		if isinstance(result, tuple):
			# Most SDK TxRx calls end with (dxl_comm_result, dxl_error).
			if len(result) >= 2 and isinstance(result[-2], int) and isinstance(result[-1], int):
				return result[-2] == self.COMM_SUCCESS and result[-1] == 0

		return False

	def _throttled_log(self, key, level, message, interval=1.0):
		"""Avoid printing the same bus error dozens of times per second."""
		now = time.time()
		last = self._last_bus_error_log.get(key, 0.0)
		if now - last >= interval:
			log.log(level, message)
			self._last_bus_error_log[key] = now

	def bus_action(self, action, label="bus action", retries=None, retry_delay=None,
				   min_interval=None, log_failures=True, blocking=True, acquire_timeout=None):
		"""
		Run one SDK transaction on the serial bus.

		Every packetHandler.*TxRx(), GroupSyncRead.txRxPacket(), and
		GroupSyncWrite.txPacket() call should go through this method.

		It provides:
		- one shared lock for all bus traffic
		- a minimum spacing between transactions
		- retry/backoff for intermittent status-packet issues
		- throttled logging so failures do not spam the console
		- optional non-blocking mode for low-priority reads
		- optional acquire_timeout: give up (return None) if the bus stays busy that long
		"""
		if retries is None:
			retries = self.bus_retries
		if retry_delay is None:
			retry_delay = self.bus_retry_delay
		if min_interval is None:
			min_interval = self.min_bus_interval

		last_result = None

		if acquire_timeout is not None:
			acquired = self.bus_lock.acquire(timeout=acquire_timeout)
		else:
			acquired = self.bus_lock.acquire(blocking=blocking)
		if not acquired:
			# Low-priority read skipped because a higher-priority bus action is running.
			return None

		try:
			for attempt in range(retries + 1):
				now = time.time()
				elapsed = now - self.last_bus_time
				if elapsed < min_interval:
					time.sleep(min_interval - elapsed)

				try:
					last_result = action()
				except Exception as e:
					last_result = e
					# The SDK sets is_using before writing and only clears it on a
					# normal return, so a write timeout would refuse every later packet.
					self.portHandler.is_using = False
					if attempt >= retries:
						if log_failures:
							self._throttled_log(
								f"{label}:exception",
								logging.ERROR,
								f"{self.device_name}: {label} exception: {e}",
								interval=1.0
							)
						raise

				self.last_bus_time = time.time()

				if self._comm_ok(last_result):
					return last_result

				if attempt < retries:
					time.sleep(retry_delay * (attempt + 1))
		finally:
			self.bus_lock.release()

		if log_failures:
			self._throttled_log(
				f"{label}:fail",
				logging.ERROR,
				f"{self.device_name}: {label} failed after {retries + 1} attempt(s): "
				f"{self._format_bus_result(last_result)}",
				interval=1.0
			)

		return last_result

	def _format_bus_result(self, result):
		"""Format SDK communication results for readable logs."""
		if isinstance(result, Exception):
			return repr(result)

		if isinstance(result, int):
			return self.packetHandler.getTxRxResult(result)

		if isinstance(result, tuple):
			if len(result) >= 2 and isinstance(result[-2], int) and isinstance(result[-1], int):
				comm_result = result[-2]
				dxl_error = result[-1]
				if comm_result != self.COMM_SUCCESS:
					return self.packetHandler.getTxRxResult(comm_result)
				if dxl_error != 0:
					return self.packetHandler.getRxPacketError(dxl_error)
				return "OK"
			return repr(result)

		return repr(result)



	def open_port(self):
		with self.lock:
			if not self.portHandler.openPort():
				log.error(f"{self.device_name}: Failed to open port.")
				return False

			log.info(f"{self.device_name}: Port opened successfully.")

			if not self.portHandler.setBaudRate(self.BAUDRATE):
				log.error(f"{self.device_name}: Failed to set baud rate.")
				self.portHandler.closePort()
				return False

			log.info(f"{self.device_name}: Baud rate set.")
			self.bound_serial_writes()

			successful_motors = 0

			for dxl_id in self.dxl_ids:
				# ShosaEdit change: write the mode only when it differs. Writing it is
				# refused while torque is on (EEPROM), and a mode write in extended
				# mode may reset the multi-turn count (e-manual), shifting the reference.
				mode, comm, err = self.bus_action(
					lambda dxl_id=dxl_id: self.packetHandler.read1ByteTxRx(
						self.portHandler, dxl_id, self.OP_MODE_ADDR),
					label=f"ID {dxl_id} read operating mode",
					retries=2
				)
				if comm == self.COMM_SUCCESS and err == 0 and mode == self.EXTENDED_POSITION_CONTROL_MODE:
					successful_motors += 1
					continue
				dxl_comm_result, dxl_error = self.bus_action(
					lambda dxl_id=dxl_id: self.packetHandler.write1ByteTxRx(
						self.portHandler,
						dxl_id,
						self.OP_MODE_ADDR,
						self.EXTENDED_POSITION_CONTROL_MODE
					),
					label=f"ID {dxl_id} set operating mode",
					retries=2
				)

				if dxl_comm_result == self.COMM_SUCCESS and dxl_error == 0:
					successful_motors += 1
				else:
					log.error(
						f"{self.device_name} ID {dxl_id}: Failed to set operating mode: "
						f"{self._format_bus_result((dxl_comm_result, dxl_error))}"
					)

			if successful_motors == 0:
				log.error(f"{self.device_name}: No motors responded. Closing port.")
				self.portHandler.closePort()
				return False

			self.port_is_open = True
			self.time_profile_ids = [dxl_id for dxl_id in self.dxl_ids
									 if self.apply_motion_profile(dxl_id)]
			missing = [dxl_id for dxl_id in self.dxl_ids if dxl_id not in self.time_profile_ids]
			if missing:
				log.warning(f"{self.device_name}: Motors {missing} kept their old motion profile "
							f"(torque was on, or no reply).")

		# Start the background reader after the port state is valid.
		self.start_realtime_thread()
		self.update_torque_status()
		return True
	def bound_serial_writes(self):
		"""Make a stuck serial write fail after SERIAL_WRITE_TIMEOUT instead of blocking forever."""
		ser = getattr(self.portHandler, 'ser', None)
		if ser is not None and ser.write_timeout != SERIAL_WRITE_TIMEOUT:
			ser.write_timeout = SERIAL_WRITE_TIMEOUT

	def close_port(self):
		# Stop the realtime thread before disabling torque/closing the port.
		# This prevents the background ping from using the serial port at the same
		# time as shutdown commands.
		with self.lock:
			if not self.port_is_open:
				return
			self.stop_realtime_thread()

		if self.realtime_thread and self.realtime_thread.is_alive():
			self.realtime_thread.join(timeout=1.0)

		with self.lock:
			if self.port_is_open:
				self.enable_all_motor_torque(False)
				self.portHandler.closePort()
				self.port_is_open = False
				log.info(f"{self.device_name}: Port closed.")


	def ping_motors(self):
		with self.lock:
			if not self.port_is_open:
				log.warning(f"{self.device_name}: Port not open.")
				return []

		successful_ids = []
		for dxl_id in self.dxl_ids:
			try:
				dxl_model_number, dxl_comm_result, dxl_error = self.bus_action(
					lambda dxl_id=dxl_id: self.packetHandler.ping(self.portHandler, dxl_id),
					label=f"ID {dxl_id} ping",
					retries=1
				)

				if dxl_comm_result == self.COMM_SUCCESS and dxl_error == 0:
					log.info(f"{self.device_name} ID {dxl_id}: Ping successful.")
					successful_ids.append(dxl_id)
				else:
					log.warning(
						f"{self.device_name} ID {dxl_id}: Ping failed: "
						f"{self._format_bus_result((dxl_model_number, dxl_comm_result, dxl_error))}"
					)
			except Exception as e:
				log.error(f"{self.device_name} ID {dxl_id}: Exception during ping: {e}")

		return successful_ids
	def start_realtime_thread(self):

		# Prevent duplicate threads
		if self.realtime_thread and self.realtime_thread.is_alive():
			return

		log.info(f"{self.device_name}: Starting realtime thread")

		self.realtime_thread_stop_event.clear()

		self.realtime_thread = threading.Thread(
			target=self.realtime_loop,
			daemon=True
		)

		self.realtime_thread.start()
  
	def stop_realtime_thread(self):

		#log.info(f"{self.device_name}: Stopping realtime thread")

		self.realtime_thread_stop_event.set()
	

	def realtime_loop(self):

		log.info(f"{self.device_name}: Realtime thread started")

		while not self.realtime_thread_stop_event.is_set():

			if not self.port_is_open:
				self.connection_alive = False
				break

			# An uncaught error would kill this thread for good (and Python
			# would print it from here, which TD must never see).
			try:
				read_interval = self._realtime_step()
			except Exception as e:
				log.exception(f"{self.device_name}: Realtime read failed: {e}")
				read_interval = 0.5

			self.realtime_thread_stop_event.wait(read_interval)

		log.info(f"{self.device_name}: Realtime thread stopped")

	def _realtime_step(self):
		"""One reader pass; returns seconds to wait before the next one."""
		# While recording, the recorder owns the bus so its samples stay on time.
		# While a task runs, a read would hold the bus for 34-100 ms (measured),
		# longer than a 33 ms frame, so motor status waits until the task ends.
		if self.recording or self.task_running:
			return 0.1

		# Motor status keeps updating while stopped or locked.
		now = time.time()
		if now - self._last_status_read >= 1.0 / self.status_hz:
			self._last_status_read = now
			self.read_motor_status(low_priority=self.task_running)

		if self.is_stop and not self.live_view:
			return 0.1

			# Playback writes have priority. While an animation is running, read
			# actual positions at a lower, non-blocking rate so reads never queue
			# in front of the next motion frame.
		idle_interval = 1.0 / max(LIVE_VIEW_HZ if self.live_view else self.realtime_hz, 1)
		read_interval = (
			1.0 / max(self.realtime_hz_during_motion, 1)
			if self.task_running else idle_interval
		)

		positions = self.get_current_positions(
			log_failures=not self.task_running,
			low_priority=self.task_running
		)

		if positions:
			self.connection_alive = True
			self.connection_fail_count = 0
			self.last_comm_time = time.time()
		else:
			self.connection_alive = False
			self.connection_fail_count += 1
			read_interval = max(read_interval, 0.5)

		return read_interval

	def hold_current_position(self):
		"""Freeze the arm at its current pose."""
		self.task_running = False
		self.task_done_event.set()
		self.stop_event.set()

		present_positions = self.get_current_positions(log_failures=True)

		with self.lock:
			if not self.port_is_open:
				log.warning(f"{self.device_name}: Port not open.")
				return

			groupSyncWrite = GroupSyncWrite(
				self.portHandler,
				self.packetHandler,
				self.ADDR_PRO_GOAL_POSITION,
				self.ADDR_PRO_GOAL_POSITION_LEN
			)

			for dxl_id in self.dxl_ids:
				position_value = present_positions.get(dxl_id, None)
				if position_value is None:
					log.error(f"{self.device_name} ID {dxl_id}: Could not get position.")
					continue

				param_goal_position = [
					DXL_LOBYTE(DXL_LOWORD(position_value)),
					DXL_HIBYTE(DXL_LOWORD(position_value)),
					DXL_LOBYTE(DXL_HIWORD(position_value)),
					DXL_HIBYTE(DXL_HIWORD(position_value))
				]
				groupSyncWrite.addParam(dxl_id, param_goal_position)

			log.info(f"{self.device_name}: Holding current position.")

			dxl_comm_result = self.bus_action(
				lambda: groupSyncWrite.txPacket(),
				label="hold pose sync write",
				retries=1
			)

			groupSyncWrite.clearParam()

			if dxl_comm_result != self.COMM_SUCCESS:
				log.error(
					f"{self.device_name}: Failed to hold pose: "
					f"{self.packetHandler.getTxRxResult(dxl_comm_result)}"
				)
			else:
				log.info(f"{self.device_name}: Pose locked.")

	def move_motors(self, targets, profile_ms=None):
		"""Send some motors to positions: {id: position, or None = torque off}.

		profile_ms, when given, is how long the move takes; playback later puts
		the normal PROFILE_TIME_MS back.
		"""
		if not self.port_is_open:
			return
		goals = {}
		for dxl_id, value in targets.items():
			if dxl_id not in self.dxl_ids:
				log.warning(f"{self.device_name}: Motor {dxl_id} is not on this arm, skipped.")
			elif value is None:
				self.torque_enabled[dxl_id] = None   # force the write, the cache may be stale
				self.enable_single_motor_torque(dxl_id, False)
			else:
				goal = int(value)
				if goal < 0 and dxl_id in (8, 9):   # right fingers; IDs are unique across both arms
					# Right fingers use signed extended-position coordinates.
					# Never silently replace a negative closing target with zero.
					with self.lock:
						mode, comm, error = self.bus_action(
							lambda: self.packetHandler.read1ByteTxRx(self.portHandler, dxl_id, 11),
							label=f"ID {dxl_id} verify signed position mode", retries=1)
					if comm != self.COMM_SUCCESS or error or mode != 4 or goal < -self.MAX_POSITION:
						log.error(f"{self.device_name} ID {dxl_id}: Negative target {goal} refused: extended mode unavailable or target out of range.")
						return
					goals[dxl_id] = goal
				else:
					goals[dxl_id] = min(max(goal, self.MIN_POSITION), self.MAX_POSITION)
		if not goals:
			return
		# Torque on first: turning torque on resets a motor's goal to where it
		# is now, so a goal written before it would be lost (the motor only
		# moved on a second click).
		for dxl_id in goals:
			self.torque_enabled[dxl_id] = None
			self.enable_single_motor_torque(dxl_id, True)
			if profile_ms is not None and self.write_profile(dxl_id, profile_ms, profile_ms / 3):
				self.custom_profile_ids.add(dxl_id)
		with self.lock:
			writer = GroupSyncWrite(self.portHandler, self.packetHandler,
									self.ADDR_PRO_GOAL_POSITION, self.ADDR_PRO_GOAL_POSITION_LEN)
			for dxl_id, value in goals.items():
				writer.addParam(dxl_id, [
					DXL_LOBYTE(DXL_LOWORD(value)), DXL_HIBYTE(DXL_LOWORD(value)),
					DXL_LOBYTE(DXL_HIWORD(value)), DXL_HIBYTE(DXL_HIWORD(value))])
			result = self.bus_action(lambda: writer.txPacket(), label="move motors", retries=1)
			writer.clearParam()
		if result != self.COMM_SUCCESS:
			log.error(f"{self.device_name}: Could not move motors: {self._format_bus_result(result)}")
			return
		log.info(f"{self.device_name}: Moved {goals}.")

	def hold_in_place(self):
		"""Hold every motor where it is now: goal = present position, then torque on."""
		# Torque-on already resets each goal to the present position on these
		# motors; writing it first as well keeps the hold exact on any that don't.
		positions = self.get_current_positions(log_failures=True)
		result = self.COMM_SUCCESS
		with self.lock:
			if not self.port_is_open:
				return
			writer = GroupSyncWrite(self.portHandler, self.packetHandler,
									self.ADDR_PRO_GOAL_POSITION, self.ADDR_PRO_GOAL_POSITION_LEN)
			for dxl_id in self.dxl_ids:
				value = positions.get(dxl_id)
				if value is None:
					continue
				writer.addParam(dxl_id, [
					DXL_LOBYTE(DXL_LOWORD(value)), DXL_HIBYTE(DXL_LOWORD(value)),
					DXL_LOBYTE(DXL_HIWORD(value)), DXL_HIBYTE(DXL_HIWORD(value))])
			result = self.bus_action(lambda: writer.txPacket(), label="hold in place", retries=1)
			writer.clearParam()
		if result != self.COMM_SUCCESS:
			log.error(f"{self.device_name}: Could not set hold positions: {self._format_bus_result(result)}")
		self.enable_all_motor_torque(True)
		log.info(f"{self.device_name}: Locked in place.")

	def _read_present_block(self):
		"""During playback: one sync read of 126..135 for every motor; stores the
		current (and the measured position separately, as present_positions), never
		retries, never waits for the bus."""
		reader = GroupSyncRead(self.portHandler, self.packetHandler,
							   self.ADDR_PRO_PRESENT_CURRENT, self.PRESENT_BLOCK_LEN)
		try:
			for dxl_id in self.dxl_ids:
				if dxl_id not in self.read_skip_ids:
					reader.addParam(dxl_id)
			result = self.bus_action(reader.txRxPacket, label="playback current read", retries=0,
									 min_interval=PLAYBACK_READ_GAP, log_failures=False, acquire_timeout=0)
			if result != self.COMM_SUCCESS:
				return 'bus busy' if result is None else self.packetHandler.getTxRxResult(result)
			now = time.time()
			missing = []
			for dxl_id in self.dxl_ids:
				if dxl_id in self.read_skip_ids:
					continue
				data = reader.data_dict.get(dxl_id) or []
				if len(data) < self.PRESENT_BLOCK_LEN:
					missing.append(dxl_id)
					continue
				raw = reader.getData(dxl_id, self.ADDR_PRO_PRESENT_CURRENT, 2)
				self.present_currents[dxl_id] = (raw - 65536 if raw > 32767 else raw, now)
				self.present_positions[dxl_id] = reader.getData(
					dxl_id, self.ADDR_PRO_PRESENT_POSITION, self.ADDR_PRO_PRESENT_POSITION_LEN)
			return f'no data from {missing}' if missing else None
		finally:
			reader.clearParam()

	def get_current_positions(self, log_failures=True, low_priority=False):
		if not self.port_is_open:
			log.warning(f"{self.device_name}: Port not open.")
			return self.current_positions

		try:
			with self.lock:
				# One block from Present Current (126) to Present Position (132):
				# same packets as a position-only read, 6 more bytes per motor.
				groupSyncRead = GroupSyncRead(
					self.portHandler,
					self.packetHandler,
					self.ADDR_PRO_PRESENT_CURRENT,
					self.PRESENT_BLOCK_LEN
				)

				for dxl_id in self.dxl_ids:
					if dxl_id not in self.read_skip_ids:   # duplicate IDs garble a sync read
						groupSyncRead.addParam(dxl_id)

				dxl_comm_result = self.bus_action(
					lambda: groupSyncRead.txRxPacket(),
					label="read positions",
					retries=0 if low_priority else 1,
					retry_delay=0.005,
					min_interval=0.0 if low_priority else None,
					log_failures=log_failures,
					blocking=not low_priority
				)

				if dxl_comm_result is None:
					# Low-priority read skipped because playback or another bus action had the bus.
					groupSyncRead.clearParam()
					return self.current_positions

				if dxl_comm_result != self.COMM_SUCCESS:
					if log_failures:
						self._throttled_log(
							"read_positions_comm",
							logging.ERROR,
							f"{self.device_name}: Failed to read positions: "
							f"{self.packetHandler.getTxRxResult(dxl_comm_result)}",
							interval=1.0
						)
					groupSyncRead.clearParam()
					return self.current_positions

				self.last_read_time = time.time()
				for dxl_id in self.dxl_ids:
					if dxl_id in self.read_skip_ids:
						continue
					# isAvailable() does not notice a short reply; check the length too.
					if (len(groupSyncRead.data_dict.get(dxl_id) or []) < self.PRESENT_BLOCK_LEN
							or not groupSyncRead.isAvailable(
								dxl_id,
								self.ADDR_PRO_PRESENT_CURRENT,
								self.PRESENT_BLOCK_LEN)):
						if log_failures:
							self._throttled_log(
								f"read_positions_unavailable_{dxl_id}",
								logging.ERROR,
								f"{self.device_name} ID {dxl_id}: Position data not available.",
								interval=1.0
							)
						continue

					position = groupSyncRead.getData(
						dxl_id,
						self.ADDR_PRO_PRESENT_POSITION,
						self.ADDR_PRO_PRESENT_POSITION_LEN
					)

					if position is not None:
						self.current_positions[dxl_id] = position
						# Raw signed register 126: Present Current on XM/XC, Present Load
						# on XL430. The caller converts it with the motor's model number.
						raw = groupSyncRead.getData(dxl_id, self.ADDR_PRO_PRESENT_CURRENT, 2)
						if raw is not None:
							self.present_currents[dxl_id] = (raw - 65536 if raw > 32767 else raw, self.last_read_time)
					elif log_failures:
						self._throttled_log(
							f"read_positions_none_{dxl_id}",
							logging.ERROR,
							f"{self.device_name} ID {dxl_id}: Failed to get position data.",
							interval=1.0
						)

				groupSyncRead.clearParam()

		except Exception as e:
			log.exception(f"{self.device_name}: Exception in get_current_positions: {e}")

		return self.current_positions

	def read_present_positions(self):
		"""Fresh signed position of every motor, or None unless every motor answered.

		Unlike get_current_positions this never falls back to the cache, which can
		be old (no reads while stopped) and holds goals, not measurements, after a playback.
		"""
		with self.lock:
			if not self.port_is_open:
				return None
			reader = GroupSyncRead(self.portHandler, self.packetHandler,
								   self.ADDR_PRO_PRESENT_POSITION, self.ADDR_PRO_PRESENT_POSITION_LEN)
			for dxl_id in self.dxl_ids:
				reader.addParam(dxl_id)
			try:
				result = self.bus_action(lambda: reader.txRxPacket(), label="read start positions",
										 retries=2, retry_delay=0.005)
				if result != self.COMM_SUCCESS:
					return None
				positions = {}
				for dxl_id in self.dxl_ids:
					if (len(reader.data_dict.get(dxl_id) or []) < self.ADDR_PRO_PRESENT_POSITION_LEN
							or not reader.isAvailable(dxl_id, self.ADDR_PRO_PRESENT_POSITION,
													  self.ADDR_PRO_PRESENT_POSITION_LEN)):
						return None
					positions[dxl_id] = _signed32(reader.getData(dxl_id, self.ADDR_PRO_PRESENT_POSITION,
																 self.ADDR_PRO_PRESENT_POSITION_LEN))
				return positions
			finally:
				reader.clearParam()

	def update_torque_status(self):
		"""Refresh torque-enabled cache for all motors."""
		for dxl_id in self.dxl_ids:
			torque_enabled, dxl_comm_result, dxl_error = self.bus_action(
				lambda dxl_id=dxl_id: self.packetHandler.read1ByteTxRx(
					self.portHandler,
					dxl_id,
					self.ADDR_PRO_TORQUE_ENABLE
				),
				label=f"ID {dxl_id} read torque status",
				retries=1
			)

			if dxl_comm_result == self.COMM_SUCCESS and dxl_error == 0:
				self.torque_enabled[dxl_id] = (torque_enabled == self.TORQUE_ENABLE)
			else:
				self.torque_enabled[dxl_id] = None
	def set_is_stop(self, is_stop):
		with self.condition:
			self.is_stop = is_stop
			self.condition.notify_all()

	#-----------------------------------------------------------------------	
	#----Torque Functions
	#-----------------------------------------------------------------------
	def apply_motion_profile(self, dxl_id):
		"""Switch one motor to the time-based profile; True when it took."""
		# Drive Mode sits in EEPROM, which only accepts writes while torque is off.
		mode, comm, error = self.bus_action(
			lambda: self.packetHandler.read1ByteTxRx(self.portHandler, dxl_id, self.ADDR_DRIVE_MODE),
			label=f"ID {dxl_id} read drive mode", retries=1, log_failures=False)
		if comm != self.COMM_SUCCESS or error != 0:
			return False
		if not mode & self.DRIVE_MODE_TIME_BASED:
			comm, error = self.bus_action(
				lambda: self.packetHandler.write1ByteTxRx(
					self.portHandler, dxl_id, self.ADDR_DRIVE_MODE, mode | self.DRIVE_MODE_TIME_BASED),
				label=f"ID {dxl_id} set drive mode", retries=1, log_failures=False)
			if comm != self.COMM_SUCCESS or error != 0:
				return False
		return self.write_profile(dxl_id, self.PROFILE_TIME_MS, self.PROFILE_ACCEL_MS)

	def write_profile(self, dxl_id, time_ms, accel_ms):
		"""Set how long (ms) this motor takes to reach a new goal; True on success."""
		for addr, value in ((self.ADDR_PRO_PROFILE_ACCELERATION, int(accel_ms)),
							(self.ADDR_PRO_PROFILE_VELOCITY, int(time_ms))):
			comm, error = self.bus_action(
				lambda addr=addr, value=value: self.packetHandler.write4ByteTxRx(
					self.portHandler, dxl_id, addr, value),
				label=f"ID {dxl_id} set profile", retries=1, log_failures=False)
			if comm != self.COMM_SUCCESS or error != 0:
				return False
		self.custom_profile_ids.discard(dxl_id)
		return True

	def read_motor_status(self, low_priority=False):
		"""Refresh motor_status and the torque cache from every motor's flags."""
		if not self.port_is_open:
			return
		blocks = {}
		with self.lock:
			reader = GroupSyncRead(self.portHandler, self.packetHandler,
								   self.ADDR_PRO_TORQUE_ENABLE, self.STATUS_BLOCK_LEN)
			for dxl_id in self.dxl_ids:
				if dxl_id not in self.read_skip_ids:
					reader.addParam(dxl_id)
			result = self.bus_action(
				lambda: reader.txRxPacket(),
				label="read motor status",
				retries=0,
				min_interval=0.0 if low_priority else None,
				log_failures=False,
				blocking=not low_priority
			)
			if result is None:
				return  # bus busy with a motion frame; try again next time
			if result == self.COMM_SUCCESS:
				for dxl_id in self.dxl_ids:
					# A short reply counts as no reply (getData would index past it).
					data = reader.data_dict.get(dxl_id) or []
					if len(data) == self.STATUS_BLOCK_LEN:
						blocks[dxl_id] = (data[0], data[-1])
			reader.clearParam()
		if result != self.COMM_SUCCESS:
			# One silent motor fails the whole sync read. While playing, keep the
			# last known status rather than spend bus time; when idle, ask each
			# motor on its own to find out which one it is.
			if low_priority:
				return
			for dxl_id in self.dxl_ids:
				data, comm, _ = self.bus_action(
					lambda dxl_id=dxl_id: self.packetHandler.readTxRx(
						self.portHandler, dxl_id, self.ADDR_PRO_TORQUE_ENABLE, self.STATUS_BLOCK_LEN),
					label=f"ID {dxl_id} read status",
					retries=0,
					log_failures=False
				)
				if comm == self.COMM_SUCCESS and data and len(data) == self.STATUS_BLOCK_LEN:
					blocks[dxl_id] = (data[0], data[-1])
		status = {}
		for dxl_id in self.dxl_ids:
			if dxl_id not in blocks:
				status[dxl_id] = 'no_reply'
				continue
			torque, hardware_error = blocks[dxl_id]
			self.torque_enabled[dxl_id] = (torque == self.TORQUE_ENABLE)
			if hardware_error:
				status[dxl_id] = 'error'
			elif torque != self.TORQUE_ENABLE:
				intentional_off = getattr(self, '_torque_requested', {}).get(dxl_id) is False
				status[dxl_id] = 'released' if self.released or intentional_off else 'torque_off'
			else:
				status[dxl_id] = 'ok'
		self.motor_status = status

	def enable_all_motor_torque(self, enable):
		with self.lock:
			if not self.port_is_open:
				log.warning(f"{self.device_name}: Port not open.")
				return
			self.released = not enable
			for dxl_id in self.dxl_ids:
				self.enable_single_motor_torque(dxl_id, enable)
	

	def enable_single_motor_torque(self, dxl_id, enable):
		with self.lock:
			if self.torque_enabled.get(dxl_id) == enable:
				self.__dict__.setdefault('_torque_requested', {})[dxl_id] = bool(enable)
				return  # No state change

			torque_status = self.TORQUE_ENABLE if enable else self.TORQUE_DISABLE

			dxl_comm_result, dxl_error = self.bus_action(
				lambda: self.packetHandler.write1ByteTxRx(
					self.portHandler,
					dxl_id,
					self.ADDR_PRO_TORQUE_ENABLE,
					torque_status
				),
				label=f"ID {dxl_id} torque change",
				retries=3,
				retry_delay=0.02
			)

			if dxl_comm_result != self.COMM_SUCCESS:
				log.error(
					f"{self.device_name} ID {dxl_id}: Torque change failed: "
					f"{self.packetHandler.getTxRxResult(dxl_comm_result)}"
				)
			elif dxl_error != 0:
				log.error(
					f"{self.device_name} ID {dxl_id}: Torque change error: "
					f"{self.packetHandler.getRxPacketError(dxl_error)}"
				)
			else:
				self.torque_enabled[dxl_id] = enable
				self.__dict__.setdefault('_torque_requested', {})[dxl_id] = bool(enable)
				status = "enabled" if enable else "disabled"
				log.info(f"{self.device_name} ID {dxl_id}: Torque {status}.")

	def set_motor_position(self, motor_id, speed, position):
		"""Set Profile Velocity and Goal Position for a single motor."""
		with self.lock:
			if not self.port_is_open:
				log.warning(f"{self.device_name}: Port not open.")
				return
			if motor_id not in self.dxl_ids:
				log.warning(f"{self.device_name}: Motor ID {motor_id} not found.")
				return

		self.enable_single_motor_torque(motor_id, True)

		with self.lock:
			if not self.port_is_open:
				return

			for addr, value, label in (
				(self.ADDR_PRO_PROFILE_ACCELERATION, speed, "profile acceleration"),
				(self.ADDR_PRO_PROFILE_VELOCITY, speed, "profile velocity"),
				(self.ADDR_PRO_GOAL_POSITION, int(position), "goal position"),
			):
				dxl_comm_result, dxl_error = self.bus_action(
					lambda addr=addr, value=value: self.packetHandler.write4ByteTxRx(
						self.portHandler,
						motor_id,
						addr,
						value
					),
					label=f"ID {motor_id} set {label}",
					retries=2
				)

				if dxl_comm_result != self.COMM_SUCCESS or dxl_error != 0:
					log.error(
						f"{self.device_name} ID {motor_id}: Failed to set {label}: "
						f"{self._format_bus_result((dxl_comm_result, dxl_error))}"
					)
					return
	def is_motor_at_position(self, motor_id, target_position, threshold=100):
		"""Return True if motor is within threshold of target."""
		current_position = self.get_current_positions().get(motor_id, None)
		if current_position is None:
			log.warning(f"{self.device_name} ID {motor_id}: Cannot read position.")
			return False
		position_diff = abs(current_position - target_position)
		log.info(f"{self.device_name} ID {motor_id}: "
					 f"Current {current_position}, Target {target_position}, Δ {position_diff}")
		return position_diff <= threshold

	def is_action_completed(self):
		return not self.task_running

	def recover_motor(self, dxl_id):
		"""
		Recover one motor that stopped responding or entered shutdown.
		"""

		log.warning(
			f"{self.device_name} ID {dxl_id}: Attempting recovery."
		)

		# Step 1: try reading hardware error
		error_status = self.read_hardware_error_status(dxl_id)

		if error_status is not None:
			log.warning(
				f"{self.device_name} ID {dxl_id}: "
				f"Hardware error status = {error_status}"
			)

		# Step 2: torque OFF
		self.bus_action(
			lambda: self.packetHandler.write1ByteTxRx(
				self.portHandler,
				dxl_id,
				self.ADDR_PRO_TORQUE_ENABLE,
				self.TORQUE_DISABLE
			),
			label=f"ID {dxl_id} torque disable",
			retries=1
		)

		time.sleep(0.05)

		# Step 3: reboot motor
		reboot_ok = self.reboot_motor(dxl_id)

		if not reboot_ok:
			log.error(
				f"{self.device_name} ID {dxl_id}: Recovery failed (reboot)."
			)
			return False

		time.sleep(0.5)

		# Step 4: restore operating mode
		dxl_comm_result, dxl_error = self.bus_action(
			lambda: self.packetHandler.write1ByteTxRx(
				self.portHandler,
				dxl_id,
				self.OP_MODE_ADDR,
				self.EXTENDED_POSITION_CONTROL_MODE
			),
			label=f"ID {dxl_id} restore mode",
			retries=2
		)

		if dxl_comm_result != self.COMM_SUCCESS or dxl_error != 0:
			log.error(
				f"{self.device_name} ID {dxl_id}: Failed restoring mode."
			)
			return False

		# A reboot resets the profile (RAM); Drive Mode (EEPROM) survives.
		self.apply_motion_profile(dxl_id)

		# Step 5: torque ON (the reboot turned it off behind the cache's back)
		self.torque_enabled[dxl_id] = None
		self.enable_single_motor_torque(dxl_id, True)

		# Step 6: test read
		positions = self.get_current_positions(log_failures=False)

		if dxl_id in positions:
			log.info(
				f"{self.device_name} ID {dxl_id}: Recovery successful."
			)
			return True

		log.error(
			f"{self.device_name} ID {dxl_id}: Recovery failed."
		)

		return False

	#-----------------------------------------------------------------------
	#----Recording Functions
	#-----------------------------------------------------------------------
	def start_record(self, frequency=30, filename='NewMovement.csv', duration=None):
		with self.lock:
			if not self.port_is_open:
				log.warning(f"{self.device_name}: Port not open.")
				return
			interval = 1.0 / frequency
			directory = os.path.join(recordings_root(), recording_folder(self.device_name))

			# Save to ./Recorded_movements/
			if not os.path.exists(directory):
				os.makedirs(directory)
				log.debug(f"{self.device_name}: Created directory {directory}.")

			filepath = os.path.join(directory, filename)
			try:
				self.file = open(filepath, mode='w', newline='')
				self.writer = csv.writer(self.file)
				log.info(f"{self.device_name}: Recording started.")
			except PermissionError as e:
				log.error(f"{self.device_name}: Cannot open file: {e}")
				return

			self.recording = True
			self.stop_event.clear()
			self.interval = interval
			self.duration = duration
			self.record_thread = threading.Thread(target=self.update_positions_during_recording)
			self.record_thread.start()
	
	def update_positions_during_recording(self):
		# Each sample keeps the time it was actually read. On stop, the take is
		# resampled onto an exact 1/frequency grid, so a late sample can no
		# longer turn into a jerk at playback (which assumes even spacing).
		start_time = time.time()
		samples = []
		cached_positions = []
		missed = 0
		try:
			next_time = start_time
			while not self.stop_event.is_set():
				current_time = time.time()
				if self.duration is not None and (current_time - start_time) >= self.duration:
					break
				before = time.time()
				previous_read = self.last_read_time
				positions = self.get_current_positions()
				if self.last_read_time != previous_read and positions:
					sample_time = (before + time.time()) / 2.0
					samples.append((sample_time, [_signed32(positions.get(dxl_id, 0)) for dxl_id in self.dxl_ids]))
				else:
					missed += 1
				# Fixed schedule, so read time does not stretch the interval.
				next_time += self.interval
				sleep_time = next_time - time.time()
				if sleep_time > 0:
					self.stop_event.wait(timeout=sleep_time)
				elif sleep_time < -self.interval:
					next_time = time.time()  # fell far behind: restart the schedule
		except Exception as e:
			log.exception(f"{self.device_name}: Exception in update_positions: {e}")
		finally:
			cached_positions = _resample(samples, 1.0 / self.interval)
			log.info(f"{self.device_name}: Recorded {len(samples)} samples "
					 f"({missed} missed) -> {len(cached_positions)} frames.")
			# Flush cached data to CSV
			if cached_positions:
				try:
					if self.file is None:
						directory = os.path.join(recordings_root(), recording_folder(self.device_name))
						if not os.path.exists(directory):
							os.makedirs(directory)
						filepath = os.path.join(directory, 'NewMovement.csv')
						self.file = open(filepath, mode='w', newline='')
						self.writer = csv.writer(self.file)
					self.writer.writerows(cached_positions)
					log.info(f"{self.device_name}: Cached data written.")
				except Exception as e:
					log.error(f"{self.device_name}: Error writing cached data: {e}")
				finally:
					if self.file:
						self.file.close()
						self.file = None
						log.info(f"{self.device_name}: Recording finished.")
	
	def end_record(self):
		self.recording = False
		self.stop_event.set()
		log.info(f"{self.device_name}: Recording stopped.")
	
	#-----------------------------------------------------------------------
	#----Playback Functions
	#-----------------------------------------------------------------------
	def play_positions(self, csv_filename, frequency=30, start_event=None, lead_in=None):
		"""Play a recording on a new thread; lead_in is frames to send before its first row."""

		with self.lock:
			if not self.port_is_open:
				log.warning(f"{self.device_name}: Port not open.")
				return
			if self.task_running:
				log.warning(f"{self.device_name}: Task already running.")
				return
			self.task_running = True
			self.task_done_event.clear()

			# The finger light (ID 10) is on for the whole playback. An arm whose
			# light did not answer before is not asked again on this connection,
			# so a missing light never delays a playback.
			if self.is_light_arm() and getattr(self, 'has_light', None) is not False:
				self.right_arm_light(state=True)

			self.playback_thread = threading.Thread(
				target=self.play_positions_worker_thread,
				args=(csv_filename, frequency, start_event, lead_in))
			self.playback_thread.start()

	def _playback_watchdog(self, done):
		"""Stop all motion if this arm's playback stops sending frames, and log where it is stuck.

		Runs on its own thread because the playback thread may be the one blocked.
		Reads thread stacks and flags only: no bus traffic, no TD objects.
		"""
		reported = False
		last_tick = time.time()
		while not done.wait(0.05):
			now = time.time()
			tick_gap = now - last_tick
			last_tick = now
			quiet = now - self._last_frame_time
			if quiet > PLAYBACK_STALL_LIMIT and not reported:
				reported = True
				self._watchdog_stall = f"no frame sent for {quiet * 1000:.0f} ms"
				log.error(f"{self.device_name}: No frame sent for {quiet * 1000:.0f} ms "
						  f"(watchdog tick gap {tick_gap * 1000:.0f} ms). Thread stacks:")
				_log_thread_stacks()
				_stop_all_motion(f"{self.device_name}: playback stalled")

	def play_positions_worker_thread(self, csv_filename, frequency, start_event=None, lead_in=None):
		finished = False
		watchdog_done = threading.Event()
		try:
			log.info(f"{self.device_name}: Playing {csv_filename}")
			if not os.path.exists(csv_filename):
				log.error(f"{self.device_name}: File not found.")
				return

			# Enable Movement
			self.set_is_stop(False)
			self.enable_all_motor_torque(True)

			# Reset overload timers
			self.overload_timers = {dxl_id: 0 for dxl_id in self.dxl_ids}

			groupSyncWrite = GroupSyncWrite(
				self.portHandler, self.packetHandler,
				self.ADDR_PRO_GOAL_POSITION,
				self.ADDR_PRO_GOAL_POSITION_LEN)
			# Motors a gesture slowed down get the normal playback profile back.
			for dxl_id in list(self.custom_profile_ids):
				self.write_profile(dxl_id, self.PROFILE_TIME_MS, self.PROFILE_ACCEL_MS)
			with open(csv_filename, mode='r') as file:
				reader = list(lead_in or []) + list(csv.reader(file))
				desired_interval = 1.0 / frequency
				if start_event is not None and not start_event.wait(START_WAIT_TIMEOUT):
					log.error(f"{self.device_name}: Synced start never came, playback cancelled.")
					return
				start_time = time.time()
				frame_count = 0
				late_frames = 0
				worst_late = 0.0
				late_detail = []    # (frame, ms late) for frames sent over 10 ms late
				total_frames = len(reader)
				# How far each motor must travel to reach frame 0 (cached positions).
				first_row = [_signed32(v) for v in reader[0]] if reader else []
				start_jump = {dxl_id: _signed32(self.current_positions.get(dxl_id, 0)) - first_row[i]
							  for i, dxl_id in enumerate(self.dxl_ids[:len(first_row)])}
				stall_reason = None
				failed_frames = 0
				read_times = []     # seconds per in-playback read
				skipped_reads = 0
				read_errors = collections.Counter()
				self._last_frame_time = start_time
				self._watchdog_stall = None
				threading.Thread(target=self._playback_watchdog, args=(watchdog_done,), daemon=True,
								 name=f"playback_watchdog_{self.device_name}").start()
				while frame_count < total_frames:
					with self.condition:
						if self.is_stop:
							log.info(f"{self.device_name}: Movement stopped.")
							break

					target_time = start_time + frame_count * desired_interval
					current_time = time.time()
					sleep_time = target_time - current_time
					if sleep_time > 0:
						time.sleep(sleep_time)
					elif sleep_time < -0.010:
						late_frames += 1
						worst_late = max(worst_late, -sleep_time)
						if len(late_detail) < 300:
							late_detail.append((frame_count, round(-sleep_time * 1000)))
						# Never flush missed frames: the backlog would throw the arm forward.
						if -sleep_time > MAX_FRAME_LATE:
							stall_reason = f"frame {frame_count} was {-sleep_time * 1000:.0f} ms late"
							break
					row = reader[frame_count]

					if not self.lock.acquire(timeout=MAX_FRAME_LATE):
						stall_reason = f"arm lock busy at frame {frame_count}"
						break
					try:
						groupSyncWrite.clearParam()
						for i, position in enumerate(row):
							dxl_id = self.dxl_ids[i]
							if dxl_id in self.faulty_motors:
								continue
							position_value = int(position)
							param_goal_position = [
								DXL_LOBYTE(DXL_LOWORD(position_value)),
								DXL_HIBYTE(DXL_LOWORD(position_value)),
								DXL_LOBYTE(DXL_HIWORD(position_value)),
								DXL_HIBYTE(DXL_HIWORD(position_value))]
							groupSyncWrite.addParam(dxl_id, param_goal_position)
							self.current_positions[dxl_id] = position_value
						dxl_comm_result = self.bus_action(
							lambda: groupSyncWrite.txPacket(),
							label="playback goal sync write",
							retries=0,
							retry_delay=0.0,
							min_interval=0.0,
							acquire_timeout=MAX_FRAME_LATE
						)
					except Exception as e:
						stall_reason = f"write failed at frame {frame_count}: {e}"
						break
					finally:
						self.lock.release()
					if dxl_comm_result is None:
						stall_reason = f"bus busy at frame {frame_count}"
						break
					frame_count += 1
					self._last_frame_time = time.time()
					if PLAYBACK_READ_EVERY and dxl_comm_result == self.COMM_SUCCESS and frame_count % PLAYBACK_READ_EVERY == 0:
						slack = start_time + frame_count * desired_interval - time.time()
						if slack > PLAYBACK_READ_SLACK and self.lock.acquire(timeout=0):
							try:
								t0 = time.time()
								error = self._read_present_block()
								read_times.append(time.time() - t0)
								if error:
									read_errors[error] += 1
							finally:
								self.lock.release()
						else:
							skipped_reads += 1
					if dxl_comm_result == self.COMM_SUCCESS:
						failed_frames = 0
					else:
						log.error(f"{self.device_name}: Failed to send positions: "
									  f"{self.packetHandler.getTxRxResult(dxl_comm_result)}")
						failed_frames += 1
						# Lost frames followed by a good one would be the same jump.
						if failed_frames >= MAX_FAILED_FRAMES:
							stall_reason = f"{failed_frames} frames in a row refused at frame {frame_count}"
							break
				if stall_reason:
					_stop_all_motion(f"{self.device_name}: {stall_reason}")
				log.info(f"{self.device_name}: Playback done: {frame_count}/{total_frames} frames, "
						 f"{late_frames} sent over 10 ms late"
						 + (f" (worst {worst_late * 1000:.0f} ms)." if late_frames else ".")
						 + (f" Current reads: {len(read_times) - sum(read_errors.values())} ok / {len(read_times)}"
							f"{' (failed: ' + ', '.join(f'{k} x{v}' for k, v in read_errors.most_common(3)) + ')' if read_errors else ''}, {skipped_reads} skipped, "
							f"avg {sum(read_times) / len(read_times) * 1000:.1f} ms, max {max(read_times) * 1000:.1f} ms."
							if read_times else f" Current reads: none ({skipped_reads} skipped)."))
				finished = frame_count >= total_frames
				self.last_playback = {'file': csv_filename, 'started': start_time, 'frames': frame_count,
									  'total': total_frames, 'seconds': time.time() - start_time,
									  'expected_seconds': total_frames * desired_interval,
									  'late': late_detail, 'start_jump': start_jump,
									  'stall': stall_reason or self._watchdog_stall}
		except Exception as e:
			log.exception(f"{self.device_name}: Exception in play_positions_thread: {e}")
			_stop_all_motion(f"{self.device_name}: playback failed: {e}")
		finally:
			watchdog_done.set()

			# Back to what the light toggle in the panel asks for.
			if self.is_light_arm() and getattr(self, 'has_light', None) is not False:
				self.right_arm_light(state=bool(_registry.get('light_on')))

			self.task_running = False
			self.task_done_event.set()

			# Only after a playback ran to the end: one cut short by LOCK or
			# STOP must keep holding its pose.
			if finished and AUTO_RELEASE_AFTER_PLAYBACK and not self.is_stop:
				self.enable_all_motor_torque(False)
				log.info(f"{self.device_name}: Released after playback.")


	def is_light_arm(self):
		"""The right arm (IDs 1-9) is the one that may carry the finger light."""
		return self.device_name == '/dev/ttyUSB1' or list(self.dxl_ids) == [1, 2, 3, 4, 5, 6, 7, 8, 9]

	def right_arm_light(self, state: bool):
		"""Switch the finger light (ID 10). One quiet attempt: not every arm has it."""
		# Write 0xFF (255) to Indirect Data 1
		value = 0xFF if state else 0x00

		with self.lock:
			if not self.port_is_open:
				return False

			result = self.bus_action(
				lambda: self.packetHandler.write1ByteTxRx(
					self.portHandler,
					self.LIGHT_FINGER_DXL_ID,
					self.ADDR_INDIRECT_DATA1,
					value
				),
				label="light write",
				retries=0,
				log_failures=False
			)

		ok = self._comm_ok(result)
		if ok != getattr(self, 'has_light', None):
			log.info(f"{self.device_name}: finger light (ID {self.LIGHT_FINGER_DXL_ID}) "
					 + ("answers." if ok else "does not answer; this arm is treated as having none."))
		self.has_light = ok
		return ok
	def delete_recorded_file(self, filename):
		file_path = os.path.join(recordings_root(), recording_folder(self.device_name), filename + ".csv")
		if os.path.exists(file_path):
			os.remove(file_path)
			log.info(f"{self.device_name}: Deleted {file_path}.")
		else:
			log.warning(f"{self.device_name}: {file_path} does not exist.")

	def rename_recorded_file(self, old_filename, new_filename):
		old_file_path = os.path.join(recordings_root(), recording_folder(self.device_name), old_filename + ".csv")
		new_file_path = os.path.join(recordings_root(), recording_folder(self.device_name), new_filename + ".csv")
		if os.path.exists(old_file_path):
			os.rename(old_file_path, new_file_path)
			log.info(f"{self.device_name}: Renamed file to {new_file_path}.")
		else:
			log.warning(f"{self.device_name}: {old_file_path} does not exist.")
  
	#-----------------------------------------------------------------------
	#----One-shot realtime command (XYZ list -> motors 1..n)
	#-----------------------------------------------------------------------

	def play_realtime(self, motor_positions):
		with self.lock:
			if not self.port_is_open:
				return

			if len(motor_positions) > len(self.dxl_ids):
				log.warning(f"{self.device_name}: Too many realtime positions.")
				return

			groupSyncWrite = GroupSyncWrite(
				self.portHandler,
				self.packetHandler,
				self.ADDR_PRO_GOAL_POSITION,
				self.ADDR_PRO_GOAL_POSITION_LEN
			)

			groupSyncWrite.clearParam()

			for i, position in enumerate(motor_positions):
				position_value = int(position)
				param_goal_position = [
					DXL_LOBYTE(DXL_LOWORD(position_value)),
					DXL_HIBYTE(DXL_LOWORD(position_value)),
					DXL_LOBYTE(DXL_HIWORD(position_value)),
					DXL_HIBYTE(DXL_HIWORD(position_value))
				]
				groupSyncWrite.addParam(self.dxl_ids[i], param_goal_position)
				self.current_positions[self.dxl_ids[i]] = position_value

			dxl_comm_result = self.bus_action(
				lambda: groupSyncWrite.txPacket(),
				label="realtime goal sync write",
				retries=1,
				retry_delay=0.005,
				log_failures=True
			)

			groupSyncWrite.clearParam()

			if dxl_comm_result != self.COMM_SUCCESS:
				log.error(
					f"{self.device_name}: Realtime write failed: "
					f"{self.packetHandler.getTxRxResult(dxl_comm_result)}"
				)
	def emergency_stop(self): 
		self.set_is_stop(True)
		self.enable_all_motor_torque(True)
		self.realtime_thread_stop_event.set()
		
	def release_arm(self):
		self.set_is_stop(True)
		self.enable_all_motor_torque(False)
  
  #---------end github------------------------------------------------------
	

	def read_hardware_error_status(self, dxl_id):
		with self.lock:
			error_status, dxl_comm_result, dxl_error = self.bus_action(
				lambda: self.packetHandler.read1ByteTxRx(
					self.portHandler,
					dxl_id,
					self.ADDR_PRO_HARDWARE_ERROR_STATUS
				),
				label=f"ID {dxl_id} read hardware error status",
				retries=2
			)

		if dxl_comm_result != self.COMM_SUCCESS:
			log.error(
				f"{self.device_name} ID {dxl_id}: Failed to read hardware error status: "
				f"{self.packetHandler.getTxRxResult(dxl_comm_result)}"
			)
			return None
		elif dxl_error != 0:
			log.error(
				f"{self.device_name} ID {dxl_id}: Error when reading hardware error status: "
				f"{self.packetHandler.getRxPacketError(dxl_error)}"
			)
			return None
		else:
			return error_status

	def reboot_motor(self, dxl_id):
		with self.lock:
			log.info(f"{self.device_name} ID {dxl_id}: Attempting to reboot.")

			dxl_comm_result, dxl_error = self.bus_action(
				lambda: self.packetHandler.reboot(self.portHandler, dxl_id),
				label=f"ID {dxl_id} reboot",
				retries=2,
				retry_delay=0.05
			)

		if dxl_comm_result != self.COMM_SUCCESS:
			log.error(
				f"{self.device_name} ID {dxl_id}: Failed to reboot: "
				f"{self.packetHandler.getTxRxResult(dxl_comm_result)}"
			)
			return False
		elif dxl_error != 0:
			log.error(
				f"{self.device_name} ID {dxl_id}: Error when rebooting: "
				f"{self.packetHandler.getRxPacketError(dxl_error)}"
			)
			return False
		else:
			log.info(f"{self.device_name} ID {dxl_id}: Rebooted successfully.")
			return True
	def clear_motor_errors(self):
		"""清除硬件错误并重新使能力矩"""
		for dxl_id in self.dxl_ids:
			error_status = self.read_hardware_error_status(dxl_id)
			if error_status is None or error_status != 0:
				log.warning(f"{self.device_name} ID {dxl_id}: Hardware "
								f"error detected. Attempting to reboot.")
				reboot_success = self.reboot_motor(dxl_id)
				if reboot_success:
					time.sleep(2.0)  # 等待电机重启
					dxl_comm_result, dxl_error = self.bus_action(
						lambda dxl_id=dxl_id: self.packetHandler.write1ByteTxRx(
							self.portHandler,
							dxl_id,
							self.OP_MODE_ADDR,
							self.EXTENDED_POSITION_CONTROL_MODE
						),
						label=f"ID {dxl_id} set operating mode after reboot",
						retries=2
					)
					if dxl_comm_result != self.COMM_SUCCESS:
						log.error(f"{self.device_name} ID {dxl_id}: Failed to "
									  f"set operating mode after reboot: "
									  f"{self.packetHandler.getTxRxResult(dxl_comm_result)}")
					elif dxl_error != 0:
						log.error(f"{self.device_name} ID {dxl_id}: Error when "
									  f"setting operating mode after reboot: "
									  f"{self.packetHandler.getRxPacketError(dxl_error)}")
					else:
						log.info(f"{self.device_name} ID {dxl_id}: Operating "
									 f"mode set after reboot.")
					self.enable_single_motor_torque(dxl_id, True)
					error_status = self.read_hardware_error_status(dxl_id)
					if error_status == 0:
						log.info(f"{self.device_name} ID {dxl_id}: Hardware "
									 f"error cleared after reboot.")
					else:
						log.error(f"{self.device_name} ID {dxl_id}: Hardware "
									  f"error persists after reboot.")
				else:
					log.error(f"{self.device_name} ID {dxl_id}: Failed to reboot.")
			else:
				# 硬件错误不存在，更新力矩状态缓存
				self.torque_enabled[dxl_id] = True


	def check_motors_status(self):
		"""检查电机状态，返回True表示全部正常"""
		all_ok = True
		self.faulty_motors = []

		for dxl_id in self.dxl_ids:
			torque_enabled, dxl_comm_result, dxl_error = self.bus_action(
				lambda dxl_id=dxl_id: self.packetHandler.read1ByteTxRx(
					self.portHandler,
					dxl_id,
					self.ADDR_PRO_TORQUE_ENABLE
				),
				label=f"ID {dxl_id} read torque status",
				retries=2
			)

			if dxl_comm_result != self.COMM_SUCCESS:
				log.error(
					f"{self.device_name} ID {dxl_id}: Failed to read torque status: "
					f"{self.packetHandler.getTxRxResult(dxl_comm_result)}"
				)
				all_ok = False
				self.faulty_motors.append(dxl_id)
				continue
			elif dxl_error != 0:
				log.error(
					f"{self.device_name} ID {dxl_id}: Error when reading torque status: "
					f"{self.packetHandler.getRxPacketError(dxl_error)}"
				)
				all_ok = False
				self.faulty_motors.append(dxl_id)
				continue
			else:
				self.torque_enabled[dxl_id] = (torque_enabled == self.TORQUE_ENABLE)
				if torque_enabled != self.TORQUE_ENABLE:
					log.warning(
						f"{self.device_name} ID {dxl_id}: Torque disabled. Attempting to re-enable."
					)
					self.enable_single_motor_torque(dxl_id, True)
					all_ok = False

			error_status = self.read_hardware_error_status(dxl_id)
			if error_status is not None and error_status != 0:
				log.error(f"{self.device_name} ID {dxl_id}: Hardware error persists.")
				self.faulty_motors.append(dxl_id)
				all_ok = False

		if self.faulty_motors:
			log.error(
				f"{self.device_name}: Motors with IDs {self.faulty_motors} have errors."
			)

		return all_ok
	def attempt_clear_errors(self, max_attempts=3):
		"""
		尝试清除电机错误，返回True表示错误已清除，False表示错误仍然存在。
		"""
		for attempt in range(max_attempts):
			self.clear_motor_errors()
			if self.check_motors_status():
				return True
			else:
				log.warning(f"{self.device_name}: Motors have errors. Attempt {attempt + 1}/{max_attempts}")
		return False

	def delete_recorded_file(self, filename):
		file_path = os.path.join(recordings_root(), recording_folder(self.device_name), filename + ".csv")

		if os.path.exists(file_path):
			os.remove(file_path)
			log.info(f"{self.device_name}: Deleted file {file_path}.")
		else:
			log.warning(f"{self.device_name}: File {file_path} does not exist.")
   
	def get_current_position_values(device_name):
		for arm in connected_arms:
			if arm.device_name == device_name:
				return [arm.current_positions.get(dxl_id, 0) for dxl_id in arm.dxl_ids]
		return []


# 以下是与机械臂连接和控制相关的函数
connected_arms = _registry.setdefault('connected_arms', [])
# Per COM port: 'connecting', 'connected', 'failed', 'disconnecting' or
# 'disconnected'. setup_arm/disconnect_arm return at once; watch this instead.
arm_states = _registry.setdefault('arm_states', {})

def setup_arm(device_name, ids=[1,2,3,4,5,6,7,8], is_admin=False):
	"""Connect an arm on the command thread; arm_states[device_name] reports the result."""
	if arm_states.get(device_name) in ('connecting', 'disconnecting'):
		log.warning(f"{device_name}: Already {arm_states[device_name]}, request ignored.")
		return
	arm_states[device_name] = 'connecting'
	_submit(f"connect {device_name}", _setup_arm_job, device_name, list(ids), is_admin)

def _setup_arm_job(device_name, ids, is_admin):
	arm = None
	try:
		_close_arms_on(device_name)
		arm = RoboticArm(device_name, ids, is_admin)
		if arm.open_port():
			arm.live_view = _registry.get('live_view', False)
			connected_arms.append(arm)
			arm_states[device_name] = 'connected'
			log.info(f"Succeeded to set up arm {device_name}.")
		else:
			arm_states[device_name] = 'failed'
			log.error(f"Failed to set up arm {device_name}.")
	except Exception as e:
		arm_states[device_name] = 'failed'
		if type(e).__name__ == 'SerialException':
			# Missing, unplugged or busy port: one line is enough.
			log.error(f"Failed to set up arm {device_name}: {e}")
		else:
			log.exception(f"Error setting up arm {device_name}: {e}")
		if arm is not None and not arm.port_is_open:
			try:
				arm.portHandler.closePort()
			except Exception:
				pass

def disconnect_arm(device_name):
	"""Disconnect an arm on the command thread; arm_states[device_name] reports the result."""
	if arm_states.get(device_name) in ('connecting', 'disconnecting'):
		log.warning(f"{device_name}: Already {arm_states[device_name]}, request ignored.")
		return
	arm_states[device_name] = 'disconnecting'
	_submit(f"disconnect {device_name}", _disconnect_arm_job, device_name)

def _disconnect_arm_job(device_name):
	try:
		_close_arms_on(device_name)
		log.info(f"Disconnected from {device_name}.")
	except Exception as e:
		log.exception(f"Error disconnecting from {device_name}: {e}")
	finally:
		arm_states[device_name] = 'disconnected'

def _close_arms_on(device_name):
	"""Stop any motion on this port, then close it and forget the arm."""
	for arm in list(connected_arms):
		if arm.device_name == device_name:
			arm.set_is_stop(True)
			arm.close_port()
			connected_arms.remove(arm)

def execute_for_all_arms(action, *args, wait_for_task=True):
	"""Run action(arm, *args) for every arm on the command thread."""
	_submit("execute_for_all_arms", _execute_for_all_arms_job, action, args, wait_for_task)

def _execute_for_all_arms_job(action, args, wait_for_task):
	for arm in list(connected_arms):
		# Wait outside arm.lock: playback needs that lock every frame to finish.
		if wait_for_task and not arm.task_done_event.wait(TASK_WAIT_TIMEOUT):
			log.warning(f"{arm.device_name}: Still busy after {TASK_WAIT_TIMEOUT:.0f} s, skipped.")
			continue
		with arm.lock:
			try:
				arm.task_done_event.clear()
				action(arm, *args)
			except Exception as e:
				log.exception(f"Error during action on {arm.device_name}: {e}")
			finally:
				arm.task_done_event.set()

def switch_admin_mode(is_admin):
	execute_for_all_arms(lambda arm: setattr(arm, 'is_admin', is_admin))

def start_record_movement(frequency=30, user='Zhou', filename='NewMovement.csv'):
	if filename != 'NewMovement.csv':
		filename = f"{filename}.csv"
	execute_for_all_arms(lambda arm: arm.start_record(frequency, filename))

def end_record_movement():
	execute_for_all_arms(lambda arm: arm.end_record())

def movement_continue():
	execute_for_all_arms(lambda arm: [arm.set_is_stop(False), arm.enable_all_motor_torque(True)])

def play_recorded_movement(filename='NewMovement', frequency=30):
	"""Start a recording on every connected arm; returns at once."""
	play_jobs = []
	for arm in list(connected_arms):
		filepath = os.path.join(recordings_root(), recording_folder(arm.device_name),
								filename + ".csv")
		if os.path.exists(filepath):
			play_jobs.append((arm, filepath))
		else:
			log.error(f"Error: File {filepath} does not exist.")
	if not play_jobs:
		return
	_submit(f"play {filename}", _play_job, play_jobs, frequency, _stop_count())

def _stop_count():
	return _registry.get('stop_count', 0)

def _note_stop():
	_registry['stop_count'] = _stop_count() + 1

def _stop_all_motion(reason):
	"""End playback on every arm so they cannot drift apart; each holds its last goal."""
	log.error(f"PLAYBACK STOPPED, all arms holding: {reason}")
	_note_stop()
	for arm in list(connected_arms):
		arm.set_is_stop(True)

def _log_thread_stacks():
	"""Log where every Python thread is right now. Safe from a worker: touches no TD object."""
	names = {t.ident: t.name for t in threading.enumerate()}
	for thread_id, frame in list(sys._current_frames().items()):
		calls = []
		while frame is not None and len(calls) < 6:
			calls.append(f"{frame.f_code.co_name}:{frame.f_lineno}")
			frame = frame.f_back
		log.error(f"  {names.get(thread_id, thread_id)}: {' < '.join(calls)}")

def _play_job(play_jobs, frequency, stop_count_at_request):
	# A stop or release pressed after this play was requested wins.
	if _stop_count() != stop_count_at_request:
		log.info("Playback cancelled by a stop that came after it.")
		return
	# All arms start together or none do: one arm moving alone can hit the other.
	busy = [arm.device_name for arm, _ in play_jobs if arm.task_running]
	if busy:
		log.error(f"PLAYBACK REFUSED: {busy} still running, no arm started.")
		return
	targets = {}
	for arm, filepath in play_jobs:
		first_row = _read_first_row(filepath)
		if not first_row or len(first_row) != len(arm.dxl_ids):
			log.error(f"PLAYBACK REFUSED: {filepath} does not match {arm.device_name}'s "
					  f"{len(arm.dxl_ids)} motors, no arm started.")
			return
		targets[arm] = first_row
	# The left claw's normal open/close travel exceeds the generic half-turn
	# guard. Exempt distance only; communication or hardware faults still refuse.
	for arm, _ in play_jobs:
		if 18 in arm.dxl_ids:   # left claw; IDs are unique across both arms
			if arm.read_hardware_error_status(18) != 0:
				log.error(f"PLAYBACK REFUSED: {arm.device_name} ID 18 hardware status is faulty or unreadable; no arm started.")
				return
	# Torque and the light are bus writes, so they happen here, not on TD's
	# main thread. Every arm's playback thread then starts on one shared event.
	for arm, _ in play_jobs:
		arm.set_is_stop(False)
		arm.enable_all_motor_torque(True)
	# Read after torque-on, which sets each goal to where the motor is now.
	starts = {}
	farthest = 0
	for arm, _ in play_jobs:
		present = arm.read_present_positions()
		if present is None:
			log.error(f"PLAYBACK REFUSED: could not read every motor on {arm.device_name}, "
					  f"no arm started, arms holding.")
			return
		starts[arm] = [present[dxl_id] for dxl_id in arm.dxl_ids]
		for dxl_id, now, goal in zip(arm.dxl_ids, starts[arm], targets[arm]):
			left_claw = dxl_id == 18
			if not left_claw and abs(now - goal) > MAX_START_DISTANCE:
				log.error(f"PLAYBACK REFUSED: {arm.device_name} ID {dxl_id} is {abs(now - goal)} counts "
						  f"from the first frame (limit {MAX_START_DISTANCE}). Wrong arm model or lost "
						  f"turn count? No arm started, arms holding.")
				return
			farthest = max(farthest, abs(now - goal))
	lead_frames = 0
	if farthest > START_TOLERANCE:
		lead_frames = max(MIN_LEAD_IN_FRAMES, int(farthest * frequency / LEAD_IN_COUNTS_PER_S))
		log.info(f"Easing to the first frame: farthest motor {farthest} counts, "
				 f"{lead_frames / frequency:.1f} s.")
	# A stop pressed during the reads above still wins.
	if _stop_count() != stop_count_at_request:
		log.info("Playback cancelled by a stop that came after it.")
		return
	start_event = threading.Event()
	for arm, filepath in play_jobs:
		try:
			lead_in = _lead_in_rows(starts[arm], targets[arm], lead_frames) if lead_frames else None
			arm.play_positions(filepath, frequency, start_event=start_event, lead_in=lead_in)
		except Exception as e:
			log.exception(f"Error during playback on {arm.device_name}: {e}")
	start_event.set()

def emergency_stop():
	"""Stop all motion now and hold the arms where they are."""
	# The stop flag is set right here so motion ends on the next frame; the
	# torque writes follow on the command thread.
	_note_stop()
	for arm in list(connected_arms):
		arm.set_is_stop(True)
	_submit("emergency stop", _for_each_arm, lambda arm: arm.enable_all_motor_torque(True))

# Gesture speed 0-100 -> how long the move takes. 100 is the playback speed
# (PROFILE_TIME_MS); each step down slows it evenly to the eye, to
# SLOWEST_MOVE_MS at 0.
SLOWEST_MOVE_MS = 2000

def speed_to_ms(speed):
	speed = min(max(float(speed), 0.0), 100.0) / 100.0
	fastest = RoboticArm.PROFILE_TIME_MS
	return int(round(SLOWEST_MOVE_MS * (fastest / SLOWEST_MOVE_MS) ** speed))

def set_light(on):
	"""Panel toggle for the finger light; playback also lights it, then returns to this.

	Arms without the light ignore it (one quiet attempt on the command thread).
	"""
	_registry['light_on'] = bool(on)
	for arm in list(connected_arms):
		if arm.port_is_open and arm.is_light_arm():
			_submit(f"light {'on' if on else 'off'} {arm.device_name}", arm.right_arm_light, bool(on))

def set_live_view(on):
	"""Read positions faster (LIVE_VIEW_HZ) while a panel is showing them."""
	_registry['live_view'] = bool(on)
	for arm in list(connected_arms):
		arm.live_view = bool(on)

def live_currents():
	"""{port: {id: (raw register 126, epoch seconds)}} from the idle reads (none during playback)."""
	return {arm.device_name: dict(getattr(arm, 'present_currents', {})) for arm in list(connected_arms) if arm.port_is_open}

def live_positions():
	"""{port: [(motor id, position), ...]} from the reader's cache. No bus traffic."""
	return {arm.device_name: [(dxl_id, arm.current_positions.get(dxl_id)) for dxl_id in arm.dxl_ids]
			for arm in list(connected_arms) if arm.port_is_open}

def move_motors(device_name, targets, speed=None):
	"""Send some motors of the arm on this port to positions; returns at once.

	targets is {motor id: position, or None to turn that motor's torque off};
	speed (0-100, None = playback speed) sets how quickly they get there.
	Works while idle, locked or recording; during a playback the next frame
	of the animation overrides motors that the animation also drives.
	"""
	for arm in list(connected_arms):
		if arm.device_name == device_name and arm.port_is_open:
			profile_ms = None if speed is None else speed_to_ms(speed)
			_submit(f"move motors {device_name}", arm.move_motors, dict(targets), profile_ms)
			return True
	return False

def lock_arms():
	"""Freeze any animation now and hold every arm exactly where it is."""
	_note_stop()
	for arm in list(connected_arms):
		arm.set_is_stop(True)
	_submit("lock arms", _for_each_arm, _lock_arm)

def _lock_arm(arm):
	# Let the playback thread notice the stop, so no motion frame lands after the hold.
	arm.task_done_event.wait(1.0)
	arm.hold_in_place()

def release_arm():
	"""Stop all motion now, then turn torque off so the arms go limp."""
	_note_stop()
	for arm in list(connected_arms):
		arm.set_is_stop(True)
	execute_for_all_arms(lambda arm: arm.enable_all_motor_torque(False))

def _for_each_arm(action):
	"""Run action on every arm at once, so a stuck arm cannot delay the other arm's stop."""
	def run_on(arm):
		try:
			action(arm)
		except Exception as e:
			log.exception(f"Error on {arm.device_name}: {e}")
	workers = [(arm, threading.Thread(target=run_on, args=(arm,), daemon=True,
									  name=f"arm_stop_{arm.device_name}"))
			   for arm in list(connected_arms)]
	for arm, worker in workers:
		worker.start()
	for arm, worker in workers:
		worker.join(TASK_WAIT_TIMEOUT)
		if worker.is_alive():
			log.error(f"{arm.device_name}: Stop command still waiting after {TASK_WAIT_TIMEOUT:.0f} s.")

def enableTorque():
	execute_for_all_arms(lambda arm: arm.enable_all_motor_torque(True))

def disableTorque():
	execute_for_all_arms(lambda arm: arm.enable_all_motor_torque(False))

def get_duration(filename):
	durations = []
	for arm in connected_arms:
		directory = os.path.join(recordings_root(), recording_folder(arm.device_name))
		file_path = os.path.join(directory, filename + ".csv")
		if not os.path.exists(file_path):
			log.warning(f"{arm.device_name}: File {file_path} does not exist.")
			continue
		try:
			with open(file_path, mode='r') as file:
				reader = csv.reader(file)
				row_count = sum(1 for row in reader)
				duration = row_count / 30
				durations.append(duration)
		except Exception as e:
			log.exception(f"{arm.device_name}: Error reading file: {e}")
	if durations:
		max_duration = max(durations)
		log.info(f"Max duration: {max_duration}")
		return max_duration
	else:
		return 0

def delete_movement_file(filename):
	execute_for_all_arms(lambda arm: arm.delete_recorded_file(filename))

def rename_movement_file(old_filename, new_filename):
	execute_for_all_arms(lambda arm: arm.rename_recorded_file(old_filename, new_filename))

def search_recorded_files():
	all_files = {}
	for arm in connected_arms:
		directory = os.path.join(recordings_root(), recording_folder(arm.device_name))
		if os.path.exists(directory):
			files_with_time = [
				(f[:-4], os.path.getmtime(os.path.join(directory, f)))
				for f in os.listdir(directory) if f.endswith('.csv')]
			for file_name, mtime in files_with_time:
				if file_name not in all_files or mtime > all_files[file_name]:
					all_files[file_name] = mtime
	sorted_files = sorted(all_files.keys(), key=lambda x: all_files[x])
	log.info(f"Recorded files: {sorted_files}")
	return sorted_files

fix_state = _registry.setdefault('fix_state', {'busy': False})

def motor_statuses(device_name):
	"""{motor id: status} for the open arm on this port, else {}. No bus traffic."""
	for arm in list(connected_arms):
		if arm.device_name == device_name and arm.port_is_open:
			return dict(getattr(arm, 'motor_status', {}))
	return {}

def _faulty_motors(arm):
	return [dxl_id for dxl_id, state in dict(getattr(arm, "motor_status", {})).items()
			if state in ('error', 'torque_off')]

def fix_motors():
	"""Recover every motor that shut itself off, on the command thread."""
	if fix_state.get('busy'):
		log.warning("Already fixing motors, request ignored.")
		return
	if not any(_faulty_motors(arm) for arm in list(connected_arms) if arm.port_is_open):
		log.info("No motors need fixing.")
		return
	fix_state['busy'] = True
	_submit("fix motors", _fix_motors_job)

def _fix_motors_job():
	try:
		for arm in list(connected_arms):
			if not arm.port_is_open:
				continue
			faulty = _faulty_motors(arm)
			if not faulty:
				continue
			# A reboot mid-animation would make the arm jump: stop this arm first.
			arm.set_is_stop(True)
			if not arm.task_done_event.wait(TASK_WAIT_TIMEOUT):
				log.warning(f"{arm.device_name}: Still busy, motors not fixed.")
				continue
			for dxl_id in faulty:
				if arm.motor_status.get(dxl_id) == 'error':
					arm.recover_motor(dxl_id)
				else:
					arm.torque_enabled[dxl_id] = None
					arm.enable_single_motor_torque(dxl_id, True)
			arm.read_motor_status()
			still = _faulty_motors(arm)
			if still:
				log.error(f"{arm.device_name}: Motors {still} still not responding properly.")
			else:
				log.info(f"{arm.device_name}: Motors {faulty} fixed.")
	finally:
		fix_state['busy'] = False

def get_current_position_values(device_name):
	"""Last known positions (cached by the reader thread, no bus traffic)."""
	for arm in list(connected_arms):
		if arm.device_name == device_name:
			return [arm.current_positions.get(dxl_id, 0) for dxl_id in arm.dxl_ids]
	log.warning(f"No arm found with device name {device_name}.")
	return None

def set_motor_position(device_name, motor_id, speed, position):
	"""设置指定机械臂的指定电机的速度和位置"""
	for arm in list(connected_arms):
		if arm.device_name == device_name:
			_submit(f"set motor {motor_id}", arm.set_motor_position, motor_id, speed, position)
			return
	log.warning(f"No arm found with device name {device_name}.")

# 修改后的 execute_motor_sequence 函数
def execute_motor_sequence(device_name, motor_sequence):
	arm = None
	for connected_arm in connected_arms:
		if connected_arm.device_name == device_name:
			arm = connected_arm
			break
	if arm is None:
		log.warning(f"未找到设备名为 {device_name} 的机械臂。")
		return

	# 检查是否已有任务在运行
	if arm.task_running:
		log.warning(f"{device_name}: 已有任务在运行。")
		return

	# 启动新线程来执行动作序列
	arm.task_running = True
	arm.task_done_event.clear()
	sequence_thread = threading.Thread(target=execute_motor_sequence_thread, args=(arm, motor_sequence))
	sequence_thread.start()

# 新的 execute_motor_sequence_thread 函数
def execute_motor_sequence_thread(arm, motor_sequence):
	try:
		for action in motor_sequence:
			motor_id = action['motor_id']
			speed = action['speed']
			position = action['position']

			log.info(f"{arm.device_name}: 开始执行电机 {motor_id} 的动作：以速度 {speed} 移动到位置 {position}")
			# 设置电机位置
			arm.set_motor_position(motor_id, speed, position)

			# 等待电机到达目标位置
			timeout = 10  # 设置一个超时时间，防止无限等待
			start_time = time.time()
			while not arm.is_motor_at_position(motor_id, position):
				if time.time() - start_time > timeout:
					log.warning(f"{arm.device_name}: 等待电机 {motor_id} 到达位置 {position} 超时")
					break
				time.sleep(0.1)  # 每 100 毫秒检查一次
	except Exception as e:
		log.exception(f"{arm.device_name}: 执行动作序列时发生异常：{e}")
	finally:
		arm.task_running = False
		arm.task_done_event.set()
		log.info(f"{arm.device_name}: 电机动作序列执行完成。")

# After a reload, arms opened by an older copy of this module still run its
# methods. Point them at the current class (running threads pick the new
# methods up on their next call) and restart a reader thread that died.
for _arm in list(connected_arms):
	if type(_arm).__name__ == 'RoboticArm' and type(_arm) is not RoboticArm:
		_arm.__class__ = RoboticArm
		if not any(_arm.torque_enabled.values()):
			_arm.released = True  # older copies flagged a limp, fresh arm as faulty
	# Fields added since that copy was loaded.
	for _attr, _default in (('last_read_time', 0.0), ('time_profile_ids', []), ('custom_profile_ids', set()), ('live_view', False), ('read_skip_ids', set()), ('present_positions', {}), ('present_currents', {})):
		if not hasattr(_arm, _attr):
			setattr(_arm, _attr, _default)
	if getattr(_arm, 'port_is_open', False) and not (_arm.realtime_thread and _arm.realtime_thread.is_alive()):
		_arm.start_realtime_thread()
	# Ports opened by an older copy never got the write timeout. This runs on TD's
	# main thread, so it must not wait for a busy bus; reconnecting also applies it.
	if getattr(_arm, 'port_is_open', False) and _arm.bus_lock.acquire(timeout=0.1):
		try:
			_arm.bound_serial_writes()
		except Exception as _e:
			log.error(f"{_arm.device_name}: Could not set the write timeout, reconnect this arm: {_e}")
		finally:
			_arm.bus_lock.release()
