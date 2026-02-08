import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import axios from "axios";
import "./LayoutAdd.css";
import "./Tests.css";
import "./Modal.css";

function Tests() {
    const { oblastId } = useParams();
    const navigate = useNavigate();

    const [testovi, setTestovi] = useState([]);
    const [oblastNaziv, setOblastNaziv] = useState("");
    const [nazivTesta, setNazivTesta] = useState("");
    const [opisTesta, setOpisTesta] = useState("");
    const [showModal, setShowModal] = useState(false);
    const [loading, setLoading] = useState(true);

    const token = localStorage.getItem("token");
    const isLoggedIn = !!token;

    const userId = localStorage.getItem("userId");
    const userRole = localStorage.getItem("userRole");
    const canAddTest = userRole === "admin" || userRole === "profesor";

    useEffect(() => {
        fetchTestovi();
    }, [oblastId]);

    const fetchTestovi = async () => {
        setLoading(true);
        try {
            const res = await axios.get(`http://localhost:5000/api/oblasti/${oblastId}/testovi`);
            setTestovi(res.data.testovi);
            setOblastNaziv(res.data.oblastNaziv);
        } catch (err) {
            console.error(err);
            setTestovi([]);
        } finally {
            setLoading(false);
        }
    };

    const dodajTest = async () => {
        if (!nazivTesta.trim()) return;
        try {
            const res = await axios.post(
                `http://localhost:5000/api/oblasti/${oblastId}/testovi`,
                { naziv: nazivTesta, opis: opisTesta },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            setTestovi([...testovi, res.data.test]);
            setNazivTesta("");
            setOpisTesta("");
            setShowModal(false);
        } catch (err) {
            console.error(err);
            alert("Dodavanje testa nije uspelo");
        }
    };

    const obrisiTest = async (test) => {
        if (!window.confirm("Da li ste sigurni da želite da obrišete test?")) return;
        try {
            if (userRole === "admin" || (userRole === "profesor" && test.authorId === userId)) {
                await axios.delete(
                    `http://localhost:5000/api/oblasti/${oblastId}/testovi/${test._id}`,
                    { headers: { Authorization: `Bearer ${token}` } }
                );
                setTestovi(testovi.filter(t => t._id !== test._id));
            } else {
                alert("Nemate dozvolu da obrišete ovaj test.");
            }
        } catch (err) {
            console.error(err);
            alert("Greška pri brisanju testa.");
        }
    };

    return (
        <>
            <div className="admin-container">
                <div className="admin-left">
                    <h1>Testovi – {oblastNaziv}</h1>
                    {loading ? <p>Ucitanje...</p> : testovi.length === 0 ? <p>Nema testova.</p> : (
                        <div className="tests-list">
                            {testovi.map(t => (
                                <div key={t._id} className="test-card">
                                    <h3 onClick={() => navigate(`/areas/${oblastId}/testovi/${t._id}`)}>
                                        {t.naziv}
                                    </h3>
                                    <p>{t.opis}</p>
                                    <small>
                                        Pitanja: {t.brojPitanja || 0} | Autor: {t.authorId === userId ? "Vi" : t.authorId}
                                    </small>
                                    <div className="test-actions">
                                        <button
                                            className="open-btn"
                                            onClick={() => navigate(`/areas/${oblastId}/testovi/${t._id}`)}
                                        >
                                            Otvori
                                        </button>
                                        {canAddTest && (userRole === "admin" || (userRole === "profesor" && t.authorId === userId)) && (
                                            <button className="delete-btn" onClick={() => obrisiTest(t)}>Obrisi</button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="admin-right">
                    <h2>Upravljanje</h2>
                    {canAddTest && <button onClick={() => setShowModal(true)}>➕ Dodaj test</button>}
                    <button style={{ marginTop: "10px" }} onClick={() => navigate("/areas")}>
                        ⬅ Nazad na oblasti
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

            {showModal && canAddTest && (
                <div className="modal-overlay">
                    <div className="modal">
                        <h2>Novi test</h2>
                        <input
                            placeholder="Naziv testa"
                            value={nazivTesta}
                            onChange={e => setNazivTesta(e.target.value)}
                        />
                        <textarea
                            placeholder="Opis testa"
                            value={opisTesta}
                            onChange={e => setOpisTesta(e.target.value)}
                        />
                        <div className="modal-actions">
                            <button onClick={() => setShowModal(false)}>Otkaži</button>
                            <button onClick={dodajTest}>Sačuvaj</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

export default Tests;





