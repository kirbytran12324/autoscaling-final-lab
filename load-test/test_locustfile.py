import unittest

import locustfile


class FakeResponse:
    def __init__(self, result, *, status_code=200, error=None):
        self._result = result
        self.status_code = status_code
        self.error = error
        self.failure_message = None
        self.was_successful = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def json(self):
        return self._result

    def failure(self, message):
        self.failure_message = message

    def success(self):
        self.was_successful = True


class FakeClient:
    def __init__(self, served_by):
        self.served_by = served_by
        self.calls = []
        self.responses = []

    def post(self, path, **kwargs):
        self.calls.append((path, kwargs))
        response = FakeResponse(
            {
                "matchId": kwargs["json"]["matchId"],
                "servedBy": self.served_by,
                "durationMs": 10,
                "simulatorVersion": "pokemon-showdown@0.11.11",
                "outcome": "win",
                "protocolHash": "a" * 64,
                "pokemon1": kwargs["json"]["pokemon1"],
                "pokemon2": kwargs["json"]["pokemon2"],
                "seed": kwargs["json"]["seed"],
                "turns": 5,
                "termination": "natural",
                "winnerSide": "p1",
                "winnerSpecies": kwargs["json"]["pokemon1"],
            }
        )
        self.responses.append(response)
        return response


def battle_user(client):
    user = object.__new__(locustfile.BattleUser)
    user.client = client
    return user


class BattleUserTests(unittest.TestCase):
    def setUp(self):
        locustfile.reset_served_by_counts(None)

    def test_battle_request_closes_connection(self):
        client = FakeClient("simulator-1")

        battle_user(client).simulate_battle()

        self.assertEqual(client.calls[0][1]["headers"], {"Connection": "close"})

    def test_test_start_resets_served_by_counts(self):
        locustfile._served_by_counts.update({"simulator-1": 3})

        locustfile.reset_served_by_counts(None)

        self.assertEqual(locustfile._served_by_counts, {})

    def test_successful_responses_are_counted_by_served_by(self):
        first_client = FakeClient("simulator-2")
        second_client = FakeClient("simulator-1")

        battle_user(first_client).simulate_battle()
        battle_user(first_client).simulate_battle()
        battle_user(second_client).simulate_battle()

        self.assertEqual(
            locustfile._served_by_counts,
            {"simulator-1": 1, "simulator-2": 2},
        )
        self.assertTrue(first_client.responses[0].was_successful)

    def test_malformed_served_by_fails_and_is_not_counted(self):
        for malformed_value in (None, 123, "", "   "):
            with self.subTest(served_by=malformed_value):
                locustfile.reset_served_by_counts(None)
                client = FakeClient(malformed_value)

                battle_user(client).simulate_battle()

                self.assertEqual(
                    client.responses[0].failure_message,
                    "HTTP 200 response field servedBy was not a non-empty string",
                )
                self.assertFalse(client.responses[0].was_successful)
                self.assertEqual(locustfile._served_by_counts, {})

    def test_invalid_results_are_not_counted(self):
        for field, value in (("durationMs", None), ("durationMs", float("nan")),
                             ("durationMs", True), ("durationMs", 10 ** 400),
                             ("simulatorVersion", ""), ("outcome", "invalid"),
                             ("protocolHash", "abc123"), ("seed", [0, 0, 0, 0]),
                             ("pokemon1", "MissingNo"), ("turns", 0),
                             ("winnerSide", "p2"), ("termination", "turn-cap")):
            with self.subTest(field=field, value=value):
                locustfile.reset_served_by_counts(None)
                client = FakeClient("simulator-1")
                original = client.post
                def post(path, **kwargs):
                    response = original(path, **kwargs)
                    response._result[field] = value
                    return response
                client.post = post
                battle_user(client).simulate_battle()
                self.assertFalse(client.responses[0].was_successful)
                self.assertIsNotNone(client.responses[0].failure_message)
                self.assertEqual(locustfile._served_by_counts, {})

    def test_required_result_fields_cannot_be_omitted(self):
        for field in locustfile.REQUIRED_RESPONSE_FIELDS:
            with self.subTest(field=field):
                locustfile.reset_served_by_counts(None)
                client = FakeClient("simulator-1")
                original = client.post
                def post(path, **kwargs):
                    response = original(path, **kwargs)
                    del response._result[field]
                    return response
                client.post = post
                battle_user(client).simulate_battle()
                self.assertFalse(client.responses[0].was_successful)
                self.assertIn('omitted required fields', client.responses[0].failure_message)
                self.assertEqual(locustfile._served_by_counts, {})

    def test_distribution_summary_is_sorted(self):
        locustfile._served_by_counts.update(
            {"simulator-z": 1, "simulator-a": 2}
        )

        with self.assertLogs(level="INFO") as captured:
            locustfile.print_served_by_distribution(None)

        self.assertEqual(
            captured.output[-1],
            "INFO:root:servedBy distribution: simulator-a=2, simulator-z=1",
        )


if __name__ == "__main__":
    unittest.main()
