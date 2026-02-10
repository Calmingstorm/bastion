package email

import (
	"fmt"
	"net/http"
	"net/smtp"
	"net/url"
	"strings"

	"github.com/Calmingstorm/bastion/server/internal/config"
)

type Service struct {
	smtpCfg    *config.SMTPConfig
	mailgunCfg *config.MailgunConfig
}

// New creates an email service. Prefer Mailgun HTTP API; fall back to SMTP.
func New(smtpCfg *config.SMTPConfig, mailgunCfg *config.MailgunConfig) *Service {
	return &Service{smtpCfg: smtpCfg, mailgunCfg: mailgunCfg}
}

func (s *Service) Send(to, subject, htmlBody string) error {
	if s.mailgunCfg != nil && s.mailgunCfg.Enabled() {
		return s.sendMailgun(to, subject, htmlBody)
	}
	if s.smtpCfg != nil && s.smtpCfg.Enabled() {
		return s.sendSMTP(to, subject, htmlBody)
	}
	return fmt.Errorf("no email backend configured")
}

func (s *Service) sendMailgun(to, subject, htmlBody string) error {
	apiURL := fmt.Sprintf("https://api.mailgun.net/v3/%s/messages", s.mailgunCfg.Domain)

	form := url.Values{}
	form.Set("from", s.mailgunCfg.From)
	form.Set("to", to)
	form.Set("subject", subject)
	form.Set("html", htmlBody)

	req, err := http.NewRequest("POST", apiURL, strings.NewReader(form.Encode()))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.SetBasicAuth("api", s.mailgunCfg.APIKey)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("mailgun request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("mailgun returned status %d", resp.StatusCode)
	}
	return nil
}

func (s *Service) sendSMTP(to, subject, htmlBody string) error {
	addr := fmt.Sprintf("%s:%s", s.smtpCfg.Host, s.smtpCfg.Port)
	auth := smtp.PlainAuth("", s.smtpCfg.Username, s.smtpCfg.Password, s.smtpCfg.Host)

	var msg strings.Builder
	msg.WriteString("From: " + s.smtpCfg.From + "\r\n")
	msg.WriteString("To: " + to + "\r\n")
	msg.WriteString("Subject: " + subject + "\r\n")
	msg.WriteString("MIME-Version: 1.0\r\n")
	msg.WriteString("Content-Type: text/html; charset=\"utf-8\"\r\n")
	msg.WriteString("\r\n")
	msg.WriteString(htmlBody)

	return smtp.SendMail(addr, auth, s.smtpCfg.From, []string{to}, []byte(msg.String()))
}
