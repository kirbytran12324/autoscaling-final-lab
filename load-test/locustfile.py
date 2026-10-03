"""Locust workload for sustained simulator battle traffic.

Set ``LOCUST_HOST`` (or pass ``--host``) to select the simulator endpoint and
``LOCUST_RUN_TIME`` (or pass ``--run-time``) to bound an experiment phase.
Set ``BATTLE_REQUEST_TIMEOUT_SECONDS`` to override the 30-second HTTP timeout.
User count and spawn rate remain Locust settings so the same workload can be
used for the low-, moderate-, and high-concurrency phases.
"""

from collections import Counter
from itertools import count
import logging
import math
import re
import os
import socket
from uuid import uuid4

from locust import HttpUser, constant, events, task

SPECIES_PAIRS = (
    ("Blissey", "Shuckle"),
    ("Umbreon", "Toxapex"),
    ("Cresselia", "Dondozo"),
    ("Lugia", "Giratina"),
    ("Dragonite", "Goodra"),
)

REQUIRED_RESPONSE_FIELDS = (
    "matchId", "pokemon1", "pokemon2", "seed", "simulatorVersion",
    "servedBy", "durationMs", "outcome", "protocolHash", "turns",
    "termination", "winnerSide", "winnerSpecies",
)

BATTLE_REQUEST_TIMEOUT_SECONDS = float(
    os.getenv("BATTLE_REQUEST_TIMEOUT_SECONDS", "30")
)

_request_numbers = count(1)
_served_by_counts: Counter[str] = Counter()
_match_id_prefix = "-".join(
    (
        os.getenv("LOAD_TEST_RUN_ID") or uuid4().hex,
        socket.gethostname(),
        str(os.getpid()),
    )
)


@events.test_start.add_listener
def reset_served_by_counts(environment, **kwargs) -> None:
    """Start each Locust run with an empty per-server distribution."""

    _served_by_counts.clear()


@events.test_stop.add_listener
def print_served_by_distribution(environment, **kwargs) -> None:
    """Log a stable summary that can be compared with the Ready Pod set."""

    distribution = ", ".join(
        f"{served_by}={_served_by_counts[served_by]}"
        for served_by in sorted(_served_by_counts)
    )
    logging.info("servedBy distribution: %s", distribution or "(none)")


def seed_from_counter(request_number: int) -> list[int]:
    """Derive four reproducible Showdown seed words from a request number."""

    return [
        (request_number * multiplier + offset) & 0xFFFF
        for multiplier, offset in (
            (17, 11),
            (31, 23),
            (43, 37),
            (59, 53),
        )
    ]


class BattleUser(HttpUser):
    # Each user immediately starts its next battle after the previous response.
    # Experiment intensity is therefore controlled directly by Locust users.
    wait_time = constant(0)

    @task
    def simulate_battle(self) -> None:
        request_number = next(_request_numbers)
        pokemon1, pokemon2 = SPECIES_PAIRS[
            (request_number - 1) % len(SPECIES_PAIRS)
        ]
        match_id = f"{_match_id_prefix}-{request_number}"
        payload = {
            "matchId": match_id,
            "pokemon1": pokemon1,
            "pokemon2": pokemon2,
            "seed": seed_from_counter(request_number),
            "maxTurns": 100,
        }

        with self.client.post(
            "/v1/battles",
            json=payload,
            name="/v1/battles",
            catch_response=True,
            headers={"Connection": "close"},
            timeout=BATTLE_REQUEST_TIMEOUT_SECONDS,
        ) as response:
            if response.error is not None:
                response.failure(response.error)
                return
            
            if response.status_code != 200:
                response.failure(f"expected HTTP 200, got {response.status_code}")
                return

            try:
                result = response.json()
            except ValueError:
                response.failure("HTTP 200 response was not valid JSON")
                return

            if not isinstance(result, dict):
                response.failure("HTTP 200 response was not a JSON object")
                return

            missing_fields = [
                field
                for field in REQUIRED_RESPONSE_FIELDS
                if field not in result
            ]
            if missing_fields:
                response.failure(
                    "HTTP 200 response omitted required fields: "
                    + ", ".join(missing_fields)
                )
                return

            if result["matchId"] != match_id:
                response.failure(
                    "HTTP 200 response matchId did not match the request: "
                    f"expected {match_id!r}, got {result['matchId']!r}"
                )
                return

            served_by = result["servedBy"]
            if not isinstance(served_by, str) or not served_by.strip():
                response.failure(
                    "HTTP 200 response field servedBy was not a non-empty string"
                )
                return

            if result.get("pokemon1") != pokemon1 or result.get("pokemon2") != pokemon2 or result.get("seed") != payload["seed"]:
                response.failure("HTTP 200 response participants or seed did not match the request")
                return
            seed = result["seed"]
            if not isinstance(seed, list) or any(isinstance(word, bool) or not isinstance(word, int) or not 0 <= word <= 65535 for word in seed):
                response.failure("HTTP 200 response seed was invalid")
                return
            version = result["simulatorVersion"]
            if not isinstance(version, str) or not version.strip():
                response.failure("HTTP 200 response simulatorVersion was invalid")
                return
            duration = result["durationMs"]
            try:
                valid_duration = not isinstance(duration, bool) and isinstance(duration, (int, float)) and math.isfinite(duration) and duration >= 0
            except OverflowError:
                valid_duration = False
            if not valid_duration:
                response.failure("HTTP 200 response durationMs was not finite and non-negative")
                return
            if result["outcome"] not in ("win", "tie"):
                response.failure("HTTP 200 response outcome was not win or tie")
                return
            if not isinstance(result["protocolHash"], str) or not re.fullmatch(r"[0-9a-f]{64}", result["protocolHash"]):
                response.failure("HTTP 200 response protocolHash was invalid")
                return
            turns = result.get("turns")
            if isinstance(turns, bool) or not isinstance(turns, int) or not 1 <= turns <= payload["maxTurns"]:
                response.failure("HTTP 200 response turns was invalid")
                return
            if result.get("termination") not in ("natural", "turn-cap"):
                response.failure("HTTP 200 response termination was invalid")
                return
            if result["termination"] == "turn-cap" and (result["outcome"] != "tie" or turns != payload["maxTurns"]):
                response.failure("HTTP 200 response turn-cap result was inconsistent")
                return
            side = result.get("winnerSide")
            winner = result.get("winnerSpecies")
            if result["outcome"] == "win":
                if side not in ("p1", "p2") or winner != (pokemon1 if side == "p1" else pokemon2):
                    response.failure("HTTP 200 response winner was inconsistent")
                    return
            elif side is not None or winner is not None:
                response.failure("HTTP 200 response tie had a winner")
                return

            response.success()
            _served_by_counts[served_by] += 1
