import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import axios from "axios";
import "./LayoutAdd.css";
import "./Kviz.css";
import "./Modal.css";

function Kviz() {
    const { oblastId, testId } = useParams();
    const navigate = useNavigate();

    const [test, setTest] = useState(null);
    const [answered, setAnswered] = useState({});
    const [showModal, setShowModal] = useState(false);
    const [tekstPitanja, setTekstPitanja] = useState("");
    const [odgovori, setOdgovori] = useState([
        { tekst: "", tacan: false },
        { tekst: "", tacan: false },
        { tekst: "", tacan: false },
        { tekst: "", tacan: false }
    ]);
    const [loading, setLoading] = useState(true);
    const [rezultat, setRezultat] = useState(null);
    const [zavrseno, setZavrseno] = useState(false);
    const [userAnswers, setUserAnswers] = useState({});

    const token = localStorage.getItem("token");
    const isLoggedIn = !!token;

    const userRole = localStorage.getItem("userRole");
    const userId = localStorage.getItem("userId");
    const isAdminOrProfesor = userRole === "admin" || userRole === "profesor";
    const canEditQuestions =
        userRole === "admin" ||
        (userRole === "profesor" && test?.authorId === userId);

    useEffect(() => {
        fetchTest();
    }, [oblastId, testId]);

    const fetchTest = async () => {
        setLoading(true);
        try {
            const res = await axios.get(
                `http://localhost:5000/api/oblasti/${oblastId}/testovi/${testId}`
            );

            const testData = {
                ...res.data,
                authorId: res.data.authorId ? res.data.authorId.toString() : null
            };

            setTest(res.data);
        } catch (err) {
            console.error(err);
            setTest(null);
        } finally {
            setLoading(false);
        }
    };

    const handleAnswerClick = (pitanjeId, odgovorId) => {
        if (zavrseno) return;

        setUserAnswers(prev => {
            const current = prev[pitanjeId] || [];

            console.log("Klik:", pitanjeId, odgovorId);

            return {
                ...prev,
                [pitanjeId]: current.includes(odgovorId)
                    ? current.filter(id => id !== odgovorId)
                    : [...current, odgovorId]
            };
        });

    };

    const submitQuiz = async () => {

        try {
            const odgovoriKorisnika = Object.keys(userAnswers).map(pid => ({
                pitanjeId: pid,
                odgovorIds: userAnswers[pid]
            }));

            console.log("SALJEM:", userAnswers);

            const payload = {
                oblastId,
                odgovoriKorisnika
            };

            if (userId) payload.userId = userId;

            const res = await axios.post(
                `http://localhost:5000/api/testovi/${testId}/rezultat`,
                payload
            );

            setRezultat(res.data);
            setZavrseno(true);

        } catch (err) {
            console.error(err.response?.data || err);
            alert("Greška pri završavanju testa");
        }

    };

    const getAnswerClass = (pitanjeId, odgovorId) => {
        if (!zavrseno) {
            const selectedAnswers = userAnswers[pitanjeId] || [];

            return selectedAnswers.includes(odgovorId)
                ? "answer selected"
                : "answer";
        }

        const r = rezultat.rezultatPoPitanju.find(
            r => r.pitanjeId === pitanjeId
        );

        if (!r) return "answer";

        if (r.tacniOdgovori.includes(odgovorId)) return "answer correct";
        if (r.korisnickiOdgovori.includes(odgovorId)) return "answer wrong";

        return "answer";

    };

    const dodajPitanje = async () => {
        if (!canEditQuestions) return;
        if (!tekstPitanja.trim()) return alert("Unesi tekst pitanja");
        if (!odgovori.some(o => o.tacan)) return alert("Moras oznaciti tacan odgovor");

        try {
            const res = await axios.post(
                `http://localhost:5000/api/oblasti/${oblastId}/testovi/${testId}/pitanja`,
                { tekst: tekstPitanja, odgovori },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            setTest({ ...test, pitanja: [...test.pitanja, res.data.pitanje] });
            setTekstPitanja("");
            setOdgovori([
                { tekst: "", tacan: false },
                { tekst: "", tacan: false },
                { tekst: "", tacan: false },
                { tekst: "", tacan: false }
            ]);
            setShowModal(false);
        } catch (err) {
            console.error(err);
            if (err.response?.status === 403) alert("Nemate dozvolu za ovu akciju");
            alert("Dodavanje pitanja nije uspelo");
        }
    };

    const obrisiPitanje = async (pitanjeId) => {
        if (!canEditQuestions) return;
        if (!window.confirm("Da li ste sigurni da zelite da obrisete pitanje?")) return;

        try {
            await axios.delete(
                `http://localhost:5000/api/oblasti/${oblastId}/testovi/${testId}/pitanja/${pitanjeId}`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            setTest({ ...test, pitanja: test.pitanja.filter(p => p._id !== pitanjeId) });
        } catch (err) {
            console.error(err);
            alert("Brisanje pitanja nije uspelo");
        }
    };

    if (loading) return <p>Ucitanje...</p>;
    if (!test) return <p>Test nije pronadjen</p>;

    return (
        <>
            <div className="admin-container">
                <div className="admin-left">
                    <h1>{test.naziv}</h1>
                    {test.pitanja.length === 0 && <p>Nema pitanja.</p>}
                    {test.pitanja.map(p => (
                        <div key={p._id} className="question-card">
                            <h3>{p.tekst}</h3>
                            <ul className="answers-list">
                                {p.odgovori.map(o => (
                                    <li
                                        key={o._id}
                                        className={getAnswerClass(p._id, o._id)}
                                        onClick={() => handleAnswerClick(p._id, o._id)}
                                    >
                                        {o.tekst}
                                        {/*{answered[p._id] && o.tacan && <span className="icon correct-icon">✔</span>}*/}
                                        {/*{answered[p._id] === o._id && !o.tacan && <span className="icon wrong-icon">✖</span>}*/}
                                    </li>
                                ))}
                            </ul>
                            {canEditQuestions && (userRole === "admin" || test.authorId === userId) && (
                                <button className="delete-btn" onClick={() => obrisiPitanje(p._id)}>Obrisi pitanje</button>
                            )}
                        </div>
                    ))}
                    {!zavrseno && (
                        <button className="submit-btn" onClick={submitQuiz}>
                            Završi kviz
                        </button>
                    )}

                    {zavrseno && (
                        <h2>

                            Rezultat: {rezultat.brojTacnih.toFixed(2)} / {rezultat.ukupnoPitanja}
                            ({Math.round((rezultat.brojTacnih / rezultat.ukupnoPitanja) * 100)}%)

                            {/*Rezultat: {rezultat.brojTacnih} / {rezultat.ukupnoPitanja}*/}
                        </h2>
                    )}
                </div>

                <div className="admin-right">
                    <h2>Upravljanje</h2>
                    {canEditQuestions && (userRole === "admin" || test.authorId === userId) && (
                        <button onClick={() => setShowModal(true)}>➕ Dodaj pitanje</button>
                    )}
                    <button style={{ marginTop: "10px" }} onClick={() => navigate(`/areas/${oblastId}/tests`)}>
                        ⬅ Nazad na testove
                    </button>

                    {isLoggedIn ? (
                        <button
                            style={{ marginTop: "10px" }}
                            onClick={() => {
                                localStorage.clear();
                                navigate("/login");
                            }}
                        >
                            🚪 Logout
                        </button>
                    ) : (
                        <button
                            style={{ marginTop: "10px" }}
                            onClick={() => navigate("/login")}
                        >
                            🔐 Login
                        </button>
                    )}
                </div>
            </div>

            {showModal && canEditQuestions && (
                <div className="modal-overlay">
                    <div className="modal">
                        <h2>Novo pitanje</h2>
                        <input
                            placeholder="Tekst pitanja"
                            value={tekstPitanja}
                            onChange={e => setTekstPitanja(e.target.value)}
                        />
                        {odgovori.map((o, i) => (
                            <div key={i} className="answer-input">
                                <input
                                    placeholder={`Odgovor ${i + 1}`}
                                    value={o.tekst}
                                    onChange={e => {
                                        const kopija = [...odgovori];
                                        kopija[i].tekst = e.target.value;
                                        setOdgovori(kopija);
                                    }}
                                />
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={o.tacan}
                                        onChange={() => {
                                            const kopija = [...odgovori];
                                            kopija[i].tacan = !kopija[i].tacan;
                                            setOdgovori(kopija);
                                        }}
                                    />
                                    Tacan
                                </label>
                            </div>
                        ))}
                        <div className="modal-actions">
                            <button onClick={() => setShowModal(false)}>Otkaži</button>
                            <button onClick={dodajPitanje}>Sačuvaj</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

export default Kviz;

